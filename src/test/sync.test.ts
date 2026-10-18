import { configureStorage } from '../private-storage';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpConfig } from '../config';
import { RemoteClient, RemoteItem, SyncEngine } from '../sync';
import { SyncState } from '../sync-state';

class MemoryRemote implements RemoteClient {
    files = new Map<string, { content: string; time: number }>();
    directories = new Set(['/remote']);
    uploads: string[] = [];
    downloads: string[] = [];
    deletes: string[] = [];
    mkdirs: string[] = [];
    failDownload = false;

    async test() {}
    async close() {}
    async stat(file: string): Promise<RemoteItem | undefined> {
        const entry = this.files.get(file);
        if (entry) { return { name: path.posix.basename(file), size: Buffer.byteLength(entry.content), modifyTime: entry.time, isDirectory: false }; }
        if (this.directories.has(file)) { return { name: path.posix.basename(file), size: 0, modifyTime: 0, isDirectory: true }; }
        return undefined;
    }
    async list(directory: string): Promise<RemoteItem[]> {
        const names = [...this.directories, ...this.files.keys()].filter((file) => file !== directory && path.posix.dirname(file) === directory),
            entries = await Promise.all(names.map((file) => this.stat(file)));
        return entries.filter((entry): entry is RemoteItem => !!entry);
    }
    async put(local: string, remote: string) {
        this.uploads.push(remote);
        this.files.set(remote, { content: fs.readFileSync(local, 'utf8'), time: 1800000000000 });
    }
    async get(remote: string, local: string) {
        this.downloads.push(remote);
        fs.writeFileSync(local, this.failDownload ? 'partial' : this.files.get(remote)!.content);
        if (this.failDownload) { throw new Error('Connection lost'); }
    }
    async mkdir(directory: string) { this.mkdirs.push(directory); this.directories.add(directory); }
    async delete(file: string) { this.deletes.push(file); this.files.delete(file); }
}

describe('two-way sync', () => {
    let storageRoot: string, localRoot: string,
        remote: MemoryRemote;
    const config = (mode: 'ftp' | 'sftp' | 'teleport' = 'sftp'): SftpConfig => ({
        mode, localPath: localRoot, remotePath: '/remote', sftpHost: 'server', sftpUser: 'user', ftpHost: 'server', ftpUser: 'user', concurrency: 4,
    }),
        writeLocal = (file: string, content: string, time = 1700000000000) => {
            const full = path.join(localRoot, file);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
            fs.utimesSync(full, new Date(time), new Date(time));
        },
        run = (options = {}) => new SyncEngine(config()).sync(remote, options);

    beforeEach(() => { storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-storage-')); configureStorage(storageRoot); localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'two-way-')); remote = new MemoryRemote(); });
    afterEach(() => { fs.rmSync(localRoot, { recursive: true, force: true }); fs.rmSync(storageRoot, { recursive: true, force: true }); });

    for (const mode of ['ftp', 'sftp', 'teleport'] as const) {
        it(`imports a remote project including empty directories via ${mode}, without deletion`, async () => {
            remote.directories.add('/remote/assets');
            remote.directories.add('/remote/empty');
            remote.files.set('/remote/assets/site.txt', { content: 'server project', time: 1700000000000 });
            const logs: string[] = [],
                result = await new SyncEngine(config(mode)).sync(remote, { onLog: (text) => logs.push(text) });
            expect(fs.readFileSync(path.join(localRoot, 'assets/site.txt'), 'utf8')).to.equal('server project');
            expect(fs.statSync(path.join(localRoot, 'empty')).isDirectory()).to.equal(true);
            expect(result).to.include('Download: 1');
            expect(logs.join('')).to.include('DOWNLOAD server to local: assets/site.txt — done');
            expect(remote.uploads).to.have.length(0);
            expect(remote.deletes).to.have.length(0);
            expect(remote.mkdirs).to.have.length(0);
            await new SyncEngine(config(mode)).sync(remote);
            expect(remote.downloads).to.have.length(1);
        });
    }

    it('uploads local-only files and downloads remote-only files in the same run', async () => {
        writeLocal('local.txt', 'local');
        remote.files.set('/remote/server.txt', { content: 'server', time: 1700000000000 });
        await run();
        expect(remote.uploads).to.deep.equal(['/remote/local.txt']);
        expect(remote.downloads).to.deep.equal(['/remote/server.txt']);
        expect(remote.deletes).to.have.length(0);
    });

    it('selects newer versions in either direction on the first run, even with different sizes', async () => {
        writeLocal('pull.txt', 'old', 1600000000000);
        writeLocal('push.txt', 'new local', 1800000000000);
        remote.files.set('/remote/pull.txt', { content: 'new remote', time: 1700000000000 });
        remote.files.set('/remote/push.txt', { content: 'old', time: 1700000000000 });
        await run();
        expect(fs.readFileSync(path.join(localRoot, 'pull.txt'), 'utf8')).to.equal('new remote');
        expect(remote.files.get('/remote/push.txt')!.content).to.equal('new local');
    });

    it('does not bounce an upload back because the server assigned a later timestamp', async () => {
        writeLocal('a.txt', 'one');
        await run();
        await run();
        expect(remote.uploads).to.have.length(1);
        expect(remote.downloads).to.have.length(0);
    });

    it('detects local content edits with unchanged size and timestamp', async () => {
        writeLocal('a.txt', 'one');
        await run();
        writeLocal('a.txt', 'two');
        await run();
        expect(remote.files.get('/remote/a.txt')!.content).to.equal('two');
        expect(remote.uploads).to.have.length(2);
    });

    it('pulls a server update after a previous sync', async () => {
        writeLocal('a.txt', 'local');
        await run();
        remote.files.set('/remote/a.txt', { content: 'git pull update', time: 1800000001000 });
        await run();
        expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal('git pull update');
        expect(remote.uploads).to.have.length(1);
    });

    it('skips both-modified conflicts and preserves their baseline across repeated runs', async () => {
        writeLocal('a.txt', 'original');
        await run();
        writeLocal('a.txt', 'local change', 1900000000000);
        remote.files.set('/remote/a.txt', { content: 'remote change', time: 1800000001000 });
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await run()).to.include('both copies changed');
        }
        expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal('local change');
        expect(remote.files.get('/remote/a.txt')!.content).to.equal('remote change');
        expect(remote.uploads).to.have.length(1);
        expect(remote.downloads).to.have.length(0);
    });

    it('restores a missing copy instead of propagating deletion', async () => {
        writeLocal('a.txt', 'keep me');
        await run();
        fs.unlinkSync(path.join(localRoot, 'a.txt'));
        await run();
        remote.files.delete('/remote/a.txt');
        await run();
        expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal('keep me');
        expect(remote.files.get('/remote/a.txt')!.content).to.equal('keep me');
        expect(remote.deletes).to.have.length(0);
    });

    it('previews both directions without writing files, directories or history', async () => {
        writeLocal('local.txt', 'local');
        remote.directories.add('/remote/empty');
        remote.files.set('/remote/server.txt', { content: 'server', time: 1700000000000 });
        const logs: string[] = [],
            result = await run({ dryRun: true, onLog: (text: string) => logs.push(text) });
        expect(result).to.include('DRY RUN');
        expect(logs.join('')).to.include('PLAN DOWNLOAD server to local: server.txt');
        expect(logs.join('')).to.include('PLAN UPLOAD local to server: local.txt');
        expect(fs.readdirSync(localRoot)).to.deep.equal(['local.txt']);
        expect(remote.uploads.concat(remote.downloads, remote.deletes, remote.mkdirs)).to.have.length(0);
    });

    it('preserves the existing file and history when a download fails', async () => {
        writeLocal('a.txt', 'original', 1600000000000);
        remote.files.set('/remote/a.txt', { content: 'remote update', time: 1700000000000 });
        remote.failDownload = true;
        let error: any;
        try { await run(); } catch (caught) { error = caught; }
        expect(error.message).to.equal('Connection lost');
        expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal('original');
        expect(fs.existsSync(path.join(localRoot, '.sftp-sync'))).to.equal(false);
        remote.failDownload = false;
        await run();
        expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal('remote update');
    });

    it('reports equal-time different-size files as conflicts', async () => {
        writeLocal('a.txt', 'a');
        remote.files.set('/remote/a.txt', { content: 'different', time: 1700000000000 });
        expect(await run()).to.include('cannot determine the newer version');
        expect(remote.uploads.concat(remote.downloads)).to.have.length(0);
    });

    it('blocks a directory/file collision including descendants', async () => {
        writeLocal('folder', 'local file');
        remote.directories.add('/remote/folder');
        remote.files.set('/remote/folder/child.txt', { content: 'remote', time: 1700000000000 });
        expect(await run()).to.include('file/directory mismatch');
        expect(remote.downloads).to.have.length(0);
        expect(fs.readFileSync(path.join(localRoot, 'folder'), 'utf8')).to.equal('local file');
    });

    it('refuses unsafe remote paths', async () => {
        remote.list = async () => [{ name: '../escape', size: 1, modifyTime: 1, isDirectory: false }];
        let error: any;
        try { await run(); } catch (caught) { error = caught; }
        expect(error.message).to.include('Unsafe remote filename');
    });

    it('does not follow local symbolic links', async () => {
        fs.symlinkSync(os.tmpdir(), path.join(localRoot, 'linked'));
        remote.directories.add('/remote/linked');
        remote.files.set('/remote/linked/escape.txt', { content: 'escape', time: 1700000000000 });
        expect(await run()).to.include('symbolic link');
        expect(remote.downloads).to.have.length(0);
    });

    it('excludes internal state and user ignore patterns in both directions', async () => {
        writeLocal('ignored.txt', 'local');
        remote.files.set('/remote/ignored.txt', { content: 'server', time: 1700000000000 });
        remote.directories.add('/remote/.sftp-sync');
        remote.files.set('/remote/.sftp-sync/state.json', { content: '{}', time: 1700000000000 });
        await new SyncEngine({ ...config(), ignore: ['ignored.txt'] }).sync(remote);
        expect(remote.uploads.concat(remote.downloads)).to.have.length(0);
    });

    it('isolates history by remote endpoint', async () => {
        writeLocal('a.txt', 'original');
        await run();
        const other = new SyncState({ ...config(), sftpHost: 'different-server' });
        await other.load();
        expect(other.records.size).to.equal(0);
    });

    it('emits progress for uploads and downloads after completion', async () => {
        writeLocal('local.txt', 'local');
        remote.files.set('/remote/remote.txt', { content: 'remote', time: 1700000000000 });
        const events: string[] = [];
        await run({ onProgress: (current: number, total: number, file: string, action: string) => events.push(`${current}/${total} ${action} ${file}`) });
        expect(events).to.have.length(2);
        expect(events[1]).to.include('2/2');
        expect(events.join(' ')).to.include('download remote.txt');
        expect(events.join(' ')).to.include('upload local.txt');
    });
    for (const action of ['upload', 'download'] as const) {
        it(`resolves a conflict with an explicit ${action} and establishes a new baseline`, async () => {
            writeLocal('a.txt', 'original');
            await run();
            writeLocal('a.txt', 'local change', 1900000000000);
            remote.files.set('/remote/a.txt', { content: 'remote change', time: 1800000001000 });
            expect(await run()).to.include('WITH CONFLICTS');
            await new SyncEngine(config()).transferFile(remote, 'a.txt', action);
            const uploads = remote.uploads.length,
                downloads = remote.downloads.length;
            expect(await run()).to.include('Conflicts: 0');
            expect(remote.uploads).to.have.length(uploads);
            expect(remote.downloads).to.have.length(downloads);
            expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal(action === 'upload' ? 'local change' : 'remote change');
        });
    }

    it('rejects corrupted history before any remote writes', async () => {
        writeLocal('a.txt', 'original');
        await run();
        const directory = new SyncState(config()).directory,
            file = fs.readdirSync(directory).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!;
        fs.writeFileSync(path.join(directory, file), 'invalid');
        let error: any;
        try { await run(); } catch (caught) { error = caught; }
        expect(error).to.exist;
        expect(remote.uploads).to.have.length(1);
    });

    it('does not replace a local file edited while downloading', async () => {
        writeLocal('a.txt', 'original', 1600000000000);
        remote.files.set('/remote/a.txt', { content: 'remote update', time: 1700000000000 });
        remote.get = async (_remote, destination) => {
            fs.writeFileSync(destination, 'remote update');
            writeLocal('a.txt', 'edited during download');
        };
        let error: any;
        try { await run(); } catch (caught) { error = caught; }
        expect(error.message).to.include('File changed after scanning');
        expect(fs.readFileSync(path.join(localRoot, 'a.txt'), 'utf8')).to.equal('edited during download');
    });

    it('reuses a Dry Run plan without listing directories again', async () => {
        remote.files.set('/remote/a.txt', { content: 'a', time: 1700000000000 });
        await run({ dryRun: true });
        remote.list = async () => { throw new Error('Unexpected rescan'); };
        const logs: string[] = [];
        await run({ onLog: (text: string) => logs.push(text) });
        expect(logs.join('')).to.include('Using Dry Run plan');
        expect(remote.downloads).to.deep.equal(['/remote/a.txt']);
    });

    for (const side of ['local', 'remote']) {
        it(`rejects a stale ${side} plan before transferring any files`, async () => {
            writeLocal('b.txt', 'local');
            remote.files.set('/remote/a.txt', { content: 'a', time: 1700000000000 });
            await run({ dryRun: true });
            if (side === 'local') { writeLocal('b.txt', 'changed'); }
            else { remote.files.set('/remote/a.txt', { content: 'changed', time: 1800000000000 }); }
            let failure: any;
            try { await run(); } catch (error) { failure = error; }
            expect(failure.message).to.include('File changed after scanning');
            expect(remote.uploads).to.have.length(0);
            expect(remote.downloads).to.have.length(0);
        });
    }

    it('rescans when ignore settings differ from the prepared plan', async () => {
        remote.files.set('/remote/a.txt', { content: 'a', time: 1700000000000 });
        await run({ dryRun: true });
        await new SyncEngine({ ...config(), ignore: ['a.txt'] }).sync(remote);
        expect(remote.downloads).to.have.length(0);
    });

    it('reports actual scanning counters for a large remote project', async () => {
        for (let i = 0; i < 1200; i++) { remote.files.set(`/remote/${i}.txt`, { content: 'x', time: 1700000000000 }); }
        const updates: any[] = [];
        await run({ dryRun: true, onState: (state: any) => updates.push(state) });
        expect(updates.some((state) => state.remoteFiles === 1200)).to.equal(true);
        expect(updates.find((state) => state.phase === 'Scanning remote files').percent).to.equal(undefined);
        expect(updates[updates.length - 1].total).to.equal(1200);
    });

    it('waits for active workers after failure and skips queued files', async () => {
        for (let i = 0; i < 12; i++) { remote.files.set(`/remote/${i}.txt`, { content: 'x', time: 1700000000000 }); }
        let active = 0, calls = 0;
        const get = remote.get.bind(remote);
        remote.get = async (source, target) => {
            active++; calls++;
            try {
                if (source.endsWith('/0.txt')) { throw new Error('Transfer failed'); }
                await new Promise((resolve) => setTimeout(resolve, 20));
                await get(source, target);
            } finally { active--; }
        };
        let failure: any;
        try { await run(); } catch (error) { failure = error; }
        expect(failure.message).to.equal('Transfer failed');
        expect(active).to.equal(0);
        expect(calls).to.be.at.most(4);
    });

    it('completes a 1200-file import from a prepared plan and can run again', async function () {
        this.timeout(15000);
        for (let i = 0; i < 1200; i++) { remote.files.set(`/remote/${i}.txt`, { content: `file ${i}`, time: 1700000000000 }); }
        await run({ dryRun: true });
        const result = await run();
        expect(result).to.include('SYNC COMPLETE');
        expect(remote.downloads).to.have.length(1200);
        await run();
        expect(remote.downloads).to.have.length(1200);
    });

    it('refuses a cached directory that was replaced with a file', async () => {
        remote.directories.add('/remote/assets');
        await run({ dryRun: true });
        writeLocal('assets', 'user data');
        let failure: any;
        try { await run(); } catch (error) { failure = error; }
        expect(failure.message).to.include('Directory changed after scanning');
        expect(fs.readFileSync(path.join(localRoot, 'assets'), 'utf8')).to.equal('user data');
    });

    it('expires a prepared plan after 30 minutes', async () => {
        await run({ dryRun: true });
        const now = Date.now, logs: string[] = [];
        Date.now = () => now() + 31 * 60 * 1000;
        try { await run({ onLog: (text: string) => logs.push(text) }); }
        finally { Date.now = now; }
        expect(logs.join('')).to.include('Plan expired');
    });

    for (const mode of ['ftp', 'sftp', 'teleport'] as const) {
        it(`caches unchanged local contents and refreshes remote listings for ${mode}`, async () => {
            writeLocal('one.txt', 'first');
            writeLocal('two.txt', 'second');
            const first: string[] = [], second: string[] = [], third: string[] = [];
            await new SyncEngine(config(mode)).sync(remote, { dryRun: true, onLog: (line) => first.push(line) });
            remote.files.set('/remote/new.txt', { content: 'new', time: 1700000000000 });
            const result = await new SyncEngine(config(mode)).sync(remote, { dryRun: true, onLog: (line) => second.push(line) });
            expect(first.join('')).to.include('0 cached, 2 hashed');
            expect(second.join('')).to.include('2 cached, 0 hashed');
            expect(result).to.include('Download: 1');
            writeLocal('one.txt', 'other');
            await new SyncEngine(config(mode)).sync(remote, { dryRun: true, onLog: (line) => third.push(line) });
            expect(third.join('')).to.include('1 cached, 1 hashed');
            expect(fs.existsSync(path.join(localRoot, '.sftp-sync'))).to.equal(false);
            expect(fs.existsSync(path.join(localRoot, '.gitignore'))).to.equal(false);
        });
    }

    for (const concurrency of [1, 4]) {
        it(`bounds parallel remote directory scans to ${concurrency}`, async () => {
            for (let i = 0; i < 8; i++) { remote.directories.add(`/remote/dir${i}`); }
            let active = 0, peak = 0;
            const list = remote.list.bind(remote);
            remote.list = async (directory) => {
                active++; peak = Math.max(peak, active);
                try { await new Promise((resolve) => setTimeout(resolve, 10)); return await list(directory); }
                finally { active--; }
            };
            await new SyncEngine({ ...config(), scanConcurrency: concurrency }).sync(remote, { dryRun: true });
            expect(peak).to.equal(concurrency);
            expect(active).to.equal(0);
        });
    }

    it('drains parallel scans on error and never executes a partial plan', async () => {
        for (let i = 0; i < 8; i++) { remote.directories.add(`/remote/dir${i}`); }
        let active = 0;
        const list = remote.list.bind(remote);
        remote.list = async (directory) => {
            active++;
            try {
                if (directory.endsWith('dir0')) { throw new Error('Listing denied'); }
                await new Promise((resolve) => setTimeout(resolve, 15));
                return await list(directory);
            } finally { active--; }
        };
        let failure: any;
        try { await run(); } catch (error) { failure = error; }
        expect(failure.message).to.equal('Listing denied');
        expect(active).to.equal(0);
        expect(remote.downloads.concat(remote.uploads, remote.mkdirs)).to.have.length(0);
    });

});
