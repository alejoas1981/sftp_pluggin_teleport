import { expect } from 'chai';
import { PendingUploads } from '../pending-uploads';
import { SftpConfig } from '../config';

describe('persistent pending uploads', () => {
    const config = { mode: 'sftp', localPath: '/project', sftpHost: 'server', sftpUser: 'user', remotePath: '/remote' } as SftpConfig;
    /** Creates durable storage shared across journal instances. */
    function storage() {
        const data = new Map<string, unknown>();
        return { get: <T>(key: string) => data.get(key) as T | undefined,
            update: async (key: string, value: unknown) => { data.set(key, value); } };
    }
    it('restores paths and removes only the successfully sent version', async () => {
        const state = storage(), queue = new PendingUploads(state);
        await queue.record(config, '/project/a');
        const batch = new Map(queue.entries(config));
        await queue.record(config, '/project/a');
        await queue.record(config, '/project/b');
        await queue.acknowledge(config, batch);
        const restored = new PendingUploads(state);
        expect([...restored.entries(config).keys()]).to.deep.equal(['/project/a', '/project/b']);
        await restored.acknowledge(config, new Map(restored.entries(config)));
        expect(new PendingUploads(state).entries(config).size).to.equal(0);
    });
    it('isolates destination changes and preserves the original destination queue', async () => {
        const state = storage(), queue = new PendingUploads(state), other = { ...config, remotePath: '/other' };
        await queue.record(config, '/project/a');
        expect(queue.entries(other).size).to.equal(0);
        await queue.record(other, '/project/b');
        expect([...queue.entries(config).keys()]).to.deep.equal(['/project/a']);
    });
    it('serializes asynchronous storage writes and exposes persistence failures', async () => {
        const state = storage();
        let release!: () => void, writes = 0;
        const queue = new PendingUploads({ get: state.get, update: async (key, value) => {
            if (++writes === 1) { await new Promise<void>((resolve) => { release = resolve; }); }
            await state.update(key, value);
        } });
        const first = queue.record(config, '/project/a'), second = queue.record(config, '/project/b');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(writes).to.equal(1); release(); await Promise.all([first, second]);
        expect(new PendingUploads(state).entries(config).size).to.equal(2);
        const failing = new PendingUploads({ get: state.get, update: async () => { throw new Error('disk full'); } });
        const failure = await failing.record(config, '/project/c').catch((error) => error);
        expect(failure.message).to.equal('disk full');
    });
});
