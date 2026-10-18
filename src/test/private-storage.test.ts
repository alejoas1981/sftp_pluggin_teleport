import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configureStorage, projectStorage } from '../private-storage';
import { SyncState } from '../sync-state';

describe('private synchronization storage', () => {
    let project: string, storage: string;
    const config = () => ({ mode: 'sftp' as const, localPath: project, remotePath: '/remote', sftpHost: 'host', sftpUser: 'user' });
    beforeEach(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-project-'));
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-private-'));
        configureStorage(storage);
    });
    afterEach(() => {
        fs.rmSync(project, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    });

    it('keeps history and download staging outside the project, without a gitignore', async () => {
        const state = new SyncState(config());
        await state.load();
        state.records.set('a', { local: { size: 1, modifyTime: 1 }, remote: { size: 1, modifyTime: 1 } });
        await state.save();
        const staging = await state.stageDownload();
        expect(staging.file.startsWith(project + path.sep)).to.equal(false);
        fs.writeFileSync(staging.file, 'x');
        await staging.dispose();
        expect(fs.existsSync(path.dirname(staging.file))).to.equal(false);
        expect(fs.readdirSync(project)).to.deep.equal([]);
    });

    it('isolates the same endpoint in different local projects', () => {
        expect(new SyncState(config()).directory).not.to.equal(new SyncState({ ...config(), localPath: path.join(project, 'other') }).directory);
    });

    it('migrates recognized legacy history and removes only verified source files', async () => {
        const directory = path.join(project, '.sftp-sync'), name = 'a'.repeat(64) + '.json',
            history = JSON.stringify({ version: 1, entries: [['file', { local: { size: 1, modifyTime: 1 }, remote: { size: 1, modifyTime: 1 } }]] });
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, name), history);
        await new SyncState(config()).load();
        expect(fs.readFileSync(path.join(projectStorage(project), name), 'utf8')).to.equal(history);
        expect(fs.existsSync(directory)).to.equal(false);
    });

    it('preserves unknown legacy files and archives a history collision', async () => {
        const state = new SyncState(config()), directory = path.join(project, '.sftp-sync'), name = 'b'.repeat(64) + '.json',
            history = JSON.stringify({ version: 1, entries: [] });
        fs.mkdirSync(directory);
        fs.mkdirSync(state.directory, { recursive: true });
        fs.writeFileSync(path.join(directory, name), history);
        fs.writeFileSync(path.join(directory, 'notes.txt'), 'user file');
        fs.writeFileSync(path.join(state.directory, name), 'newer private history');
        await state.load();
        expect(fs.readFileSync(path.join(state.directory, name), 'utf8')).to.equal('newer private history');
        expect(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8')).to.equal('user file');
        expect(fs.readdirSync(path.join(state.directory, 'legacy'))).to.have.length(1);
    });

    it('rejects storage inside the project or its workspace', () => {
        configureStorage(path.join(project, 'internal'));
        expect(() => projectStorage(project)).to.throw('outside');
        configureStorage(path.join(storage, 'internal'), [storage]);
        expect(() => projectStorage(project)).to.throw('outside');
    });

    it('does not replace legacy state by following a symbolic link', async () => {
        fs.symlinkSync(storage, path.join(project, '.sftp-sync'));
        let error: any;
        try { await new SyncState(config()).load(); } catch (caught) { error = caught; }
        expect(error.message).to.include('Unsafe legacy');
    });
    it('restores the successful baseline from the actual legacy endpoint filename', async () => {
        const original = new SyncState(config()), record = { local: { size: 5, modifyTime: 1, hash: 'content' }, remote: { size: 5, modifyTime: 2 } };
        await original.load(); original.records.set('file.txt', record); await original.save();
        const filename = fs.readdirSync(original.directory).find((name) => name.endsWith('.json'))!,
            legacy = path.join(project, '.sftp-sync');
        fs.mkdirSync(legacy);
        fs.renameSync(path.join(original.directory, filename), path.join(legacy, filename));
        const migrated = new SyncState(config());
        await migrated.load();
        expect(migrated.records.get('file.txt')).to.deep.equal(record);
        expect(fs.existsSync(legacy)).to.equal(false);
    });

});
