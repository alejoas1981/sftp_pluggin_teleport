import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpConfig } from '../config';
import { RemoteClient, RemoteItem, SyncEngine } from '../sync';

class FakeClient implements RemoteClient {
    public mkdirs: string[] = [];
    public uploads: { local: string; remote: string }[] = [];
    public downloads: { remote: string; local: string }[] = [];
    public deletes: string[] = [];
    public lists = new Map<string, RemoteItem[]>();
    public closed = false;

    async test(): Promise<void> { return; }
    async list(remoteDir: string): Promise<RemoteItem[]> {
        return this.lists.get(remoteDir) || [];
    }
    async stat(_remotePath: string): Promise<RemoteItem | undefined> {
        return undefined;
    }
    async put(localPath: string, remotePath: string): Promise<void> {
        this.uploads.push({ local: localPath, remote: remotePath });
    }
    async get(remotePath: string, localPath: string): Promise<void> {
        this.downloads.push({ remote: remotePath, local: localPath });
    }
    async mkdir(remotePath: string): Promise<void> {
        this.mkdirs.push(remotePath);
    }
    async delete(remotePath: string): Promise<void> {
        this.deletes.push(remotePath);
    }
    async close(): Promise<void> {
        this.closed = true;
    }
}

function buildConfig(localRoot: string, remoteRoot = '/remote'): SftpConfig {
    return {
        mode: 'sftp',
        sftpHost: 'h',
        sftpUser: 'u',
        localPath: localRoot,
        remotePath: remoteRoot,
        concurrency: 4,
        ignore: [],
    };
}

describe('SyncEngine', () => {
    let localRoot: string;

    beforeEach(() => {
        localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-test-'));
    });

    afterEach(() => {
        fs.rmSync(localRoot, { recursive: true, force: true });
    });

    it('uploads new files and creates directories', async () => {
        fs.writeFileSync(path.join(localRoot, 'a.txt'), 'a');
        fs.mkdirSync(path.join(localRoot, 'dir'));
        fs.writeFileSync(path.join(localRoot, 'dir', 'b.txt'), 'b');

        const client = new FakeClient();
        const config = buildConfig(localRoot);
        const result = await new SyncEngine(config).sync(client, {});

        expect(result).to.include('SYNC COMPLETE');
        expect(client.mkdirs).to.include('/remote');
        expect(client.mkdirs).to.include('/remote/dir');
        expect(client.uploads).to.have.length(2);
        const uploaded = client.uploads.map((u) => u.remote);
        expect(uploaded).to.include('/remote/a.txt');
        expect(uploaded).to.include('/remote/dir/b.txt');
    });

    it('deletes remote files missing locally', async () => {
        const client = new FakeClient();
        client.lists.set('/remote', [{ name: 'old.txt', size: 1, modifyTime: 0, isDirectory: false }]);
        const config = buildConfig(localRoot);

        const result = await new SyncEngine(config).sync(client, {});

        expect(result).to.include('SYNC COMPLETE');
        expect(client.deletes).to.include('/remote/old.txt');
        expect(client.uploads).to.have.length(0);
    });

    it('skips unchanged files', async () => {
        const filePath = path.join(localRoot, 'same.txt');
        fs.writeFileSync(filePath, 'same');
        const localStat = fs.statSync(filePath);

        const client = new FakeClient();
        client.lists.set('/remote', [{
            name: 'same.txt',
            size: localStat.size,
            modifyTime: localStat.mtimeMs,
            isDirectory: false,
        }]);
        const config = buildConfig(localRoot);

        await new SyncEngine(config).sync(client, {});

        expect(client.uploads).to.have.length(0);
        expect(client.deletes).to.have.length(0);
    });

    it('dry run does not execute transfers', async () => {
        fs.writeFileSync(path.join(localRoot, 'a.txt'), 'a');

        const client = new FakeClient();
        const config = buildConfig(localRoot);
        const result = await new SyncEngine(config).sync(client, { dryRun: true });

        expect(result).to.include('DRY RUN');
        expect(client.uploads).to.have.length(0);
        expect(client.deletes).to.have.length(0);
    });

    it('emits onProgress for each executed action', async () => {
        fs.writeFileSync(path.join(localRoot, 'a.txt'), 'a');
        fs.mkdirSync(path.join(localRoot, 'dir'));
        fs.writeFileSync(path.join(localRoot, 'dir', 'b.txt'), 'b');

        const client = new FakeClient();
        const config = buildConfig(localRoot);
        const events: Array<{ current: number; total: number; file: string; action: string }> = [];
        const result = await new SyncEngine(config).sync(client, {
            onProgress: (current, total, file, action) => events.push({ current, total, file, action }),
        });

        expect(result).to.include('SYNC COMPLETE');
        expect(events).to.have.length(3);
        expect(events.some((e) => e.current === 3 && e.total === 3)).to.be.true;
    });
});
