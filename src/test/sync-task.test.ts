import { expect } from 'chai';
import { SyncTask } from '../sync-task';

describe('extension-owned synchronization state', () => {
    it('survives closed and throwing observers, restores final state and starts again', () => {
        const task = new SyncTask(), received: any[] = [], detach = task.subscribe(() => { throw new Error('Webview disposed'); });
        task.start(false);
        task.update({ current: 1, total: 2, percent: 50 });
        detach();
        task.log('DOWNLOAD a — done');
        task.finish('SYNC COMPLETE');
        expect(task.snapshot()!.status).to.equal('complete');
        expect(task.snapshot()!.percent).to.equal(100);
        const observe = task.subscribe((state) => received.push(state));
        task.start(true);
        expect(received[0].current).to.equal(0);
        expect(() => task.start(true)).to.throw('already in progress');
        task.finish('Network unavailable', true);
        expect(task.snapshot()!.status).to.equal('error');
        expect(task.snapshot()!.percent).to.equal(undefined);
        observe(); task.dispose();
    });

    it('bounds logs and publishes elapsed time while awaiting slow network operations', async () => {
        const task = new SyncTask(), updates: any[] = [];
        task.subscribe((state) => updates.push(state));
        task.start(true);
        for (let i = 0; i < 600; i++) { task.log(`file ${i}`); }
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(updates.length).to.equal(2);
        expect(updates[1].elapsedMs).to.be.greaterThan(0);
        expect(updates[1].logs).to.have.length(500);
        expect(updates[1].percent).to.equal(undefined);
        task.finish('DRY RUN'); task.dispose();
    });
});
