import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalChangeDiscovery } from '../local-change-discovery';
import { configureStorage } from '../private-storage';
import { fingerprintLocal, SyncState } from '../sync-state';
import { SftpConfig } from '../config';

describe('offline local change discovery', () => {
    let local: string, storage: string;
    /** Returns a destination with a disposable local project. */
    const config = (): SftpConfig => ({ mode: 'sftp', localPath: local, remotePath: '/remote', sftpHost: 'host', sftpUser: 'user' });
    /** Performs local discovery with a durable queue stand in. */
    const scan = async (cfg = config()): Promise<string[]> => {
        const files: string[] = [];
        await new LocalChangeDiscovery().scan(cfg, async (file) => { files.push(path.relative(local, file)); }, new AbortController().signal);
        return files.sort();
    };
    beforeEach(() => {
        local = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-local-'));
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-private-'));
        configureStorage(storage);
    });
    afterEach(() => { fs.rmSync(local, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true }); });
    it('establishes a first inventory without uploading the project, then detects edited and new files', async () => {
        fs.writeFileSync(path.join(local, 'same.txt'), 'same');
        fs.writeFileSync(path.join(local, 'edited.txt'), 'before');
        expect(await scan()).to.deep.equal([]);
        fs.writeFileSync(path.join(local, 'edited.txt'), 'after');
        fs.writeFileSync(path.join(local, 'new.txt'), 'new');
        expect(await scan()).to.deep.equal(['edited.txt', 'new.txt']);
        expect(await scan()).to.deep.equal([]);
    });
    it('uses successful history even without a previous inventory and does not requeue successful versions', async () => {
        const file = path.join(local, 'tracked.txt'), state = new SyncState(config());
        fs.writeFileSync(file, 'before');
        await state.load();
        state.records.set('tracked.txt', { local: (await fingerprintLocal(file))!, remote: { size: 6, modifyTime: 1 } });
        await state.save();
        fs.writeFileSync(file, 'after');
        expect(await scan()).to.deep.equal(['tracked.txt']);
        state.records.set('tracked.txt', { local: (await fingerprintLocal(file))!, remote: { size: 5, modifyTime: 2 } });
        await state.save();
        expect(await scan()).to.deep.equal([]);
    });
    it('never queues deletions, symbolic links or excluded paths', async () => {
        fs.writeFileSync(path.join(local, 'removed.txt'), 'before');
        await scan();
        fs.unlinkSync(path.join(local, 'removed.txt'));
        for (const directory of ['.git', '.vscode', 'node_modules']) {
            fs.mkdirSync(path.join(local, directory)); fs.writeFileSync(path.join(local, directory, 'file'), 'hidden');
        }
        fs.writeFileSync(path.join(local, '.env'), 'hidden');
        fs.symlinkSync(storage, path.join(local, 'linked'));
        expect(await scan({ ...config(), ignore: ['node_modules', '.env'] })).to.deep.equal([]);
    });
    it('isolates first inventories by remote destination', async () => {
        await scan(); fs.writeFileSync(path.join(local, 'new.txt'), 'new');
        expect(await scan({ ...config(), remotePath: '/other' })).to.deep.equal([]);
        expect(await scan()).to.deep.equal(['new.txt']);
    });
    it('does not advance inventory when persisting discovered paths fails', async () => {
        await scan(); fs.writeFileSync(path.join(local, 'new.txt'), 'new');
        const failure = await new LocalChangeDiscovery().scan(config(), async () => { throw new Error('storage failure'); }, new AbortController().signal).catch((error) => error);
        expect(failure.message).to.equal('storage failure');
        expect(await scan()).to.deep.equal(['new.txt']);
    });
    it('cancels before committing an inventory or a pending path', async () => {
        const controller = new AbortController(); controller.abort();
        const failure = await new LocalChangeDiscovery().scan(config(), async () => { throw new Error('must not queue'); }, controller.signal).catch((error) => error);
        expect(failure.message).to.include('cancelled');
        expect(fs.existsSync(new SyncState(config()).localInventoryFile)).to.equal(false);
    });
    it('does not commit a new baseline when deactivated during discovery', async () => {
        await scan();
        const controller = new AbortController(), state = new SyncState(config()), original = fs.readFileSync(state.localInventoryFile, 'utf8');
        fs.writeFileSync(path.join(local, 'new.txt'), 'new');
        const failure = await new LocalChangeDiscovery().scan(config(), async () => { controller.abort(); }, controller.signal).catch((error) => error);
        expect(failure.message).to.include('cancelled');
        expect(fs.readFileSync(state.localInventoryFile, 'utf8')).to.equal(original);
        expect(await scan()).to.deep.equal(['new.txt']);
    });
    it('rejects a corrupted inventory without turning all files into uploads', async () => {
        const state = new SyncState(config()); await scan();
        fs.writeFileSync(state.localInventoryFile, '{bad');
        let queued = 0;
        const failure = await new LocalChangeDiscovery().scan(config(), async () => { queued++; }, new AbortController().signal).catch((error) => error);
        expect(failure).to.be.instanceOf(Error); expect(queued).to.equal(0);
    });
});
