import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configureStorage, projectStorage } from '../private-storage';
import { ScanCache } from '../scan-cache';

// Real files verify invalidation even when a writer restores the old modification time.
describe('persistent local scan cache', () => {
    let project: string, storage: string;
    beforeEach(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-project-'));
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-private-'));
        configureStorage(storage);
        fs.writeFileSync(path.join(project, 'file.txt'), 'first');
    });
    afterEach(() => {
        fs.rmSync(project, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    });

    it('reuses persisted hashes without reading unchanged file contents', async () => {
        const first = new ScanCache(project);
        await first.load();
        const fingerprint = await first.fingerprint('file.txt');
        await first.save();
        const second = new ScanCache(project);
        await second.load();
        expect(await second.fingerprint('file.txt')).to.include({ hash: fingerprint!.hash });
        expect(second.hits).to.equal(1);
        expect(second.hashed).to.equal(0);
        expect(fs.readdirSync(project)).to.deep.equal(['file.txt']);
    });

    it('rehashes same-size edits with restored mtime and replaces the cache entry', async () => {
        const cache = new ScanCache(project), file = path.join(project, 'file.txt');
        await cache.load();
        const original = await cache.fingerprint('file.txt'), before = fs.statSync(file);
        fs.writeFileSync(file, 'other');
        fs.utimesSync(file, before.atime, before.mtime);
        const changed = await cache.fingerprint('file.txt');
        expect(changed!.hash).not.to.equal(original!.hash);
        expect(cache.hashed).to.equal(2);
        expect(cache.hits).to.equal(0);
    });

    it('bypasses cache for full verification and expires old entries', async () => {
        const cache = new ScanCache(project);
        await cache.load();
        await cache.fingerprint('file.txt');
        await cache.fingerprint('file.txt', true);
        expect(cache.hashed).to.equal(2);
        const now = Date.now;
        Date.now = () => now() + 25 * 60 * 60 * 1000;
        try { await cache.fingerprint('file.txt'); }
        finally { Date.now = now; }
        expect(cache.hashed).to.equal(3);
    });

    it('rebuilds corrupted cache instead of using it as sync history', async () => {
        const directory = projectStorage(project);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'local-hashes.json'), 'broken json');
        const cache = new ScanCache(project);
        await cache.load();
        await cache.fingerprint('file.txt');
        expect(cache.hashed).to.equal(1);
        await cache.save();
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'local-hashes.json'), 'utf8')).version).to.equal(1);
    });

    it('prunes deleted paths and refuses symbolic links', async () => {
        const cache = new ScanCache(project);
        await cache.load();
        await cache.fingerprint('file.txt');
        cache.prune([]);
        await cache.save();
        expect(JSON.parse(fs.readFileSync(path.join(projectStorage(project), 'local-hashes.json'), 'utf8')).entries).to.have.length(0);
        fs.symlinkSync(path.join(project, 'file.txt'), path.join(project, 'link'));
        let error: any;
        try { await cache.fingerprint('link'); } catch (caught) { error = caught; }
        expect(error.message).to.include('Not a regular file');
    });
});
