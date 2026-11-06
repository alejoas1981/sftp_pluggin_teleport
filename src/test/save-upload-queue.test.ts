import { expect } from 'chai';
import { SaveUploadQueue } from '../save-upload-queue';

const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
describe('save upload queue', () => {
    it('retains a request while another operation is busy and cancels pending work on disposal', async () => {
        let busy = true, runs = 0;
        const queue = new SaveUploadQueue(async () => { runs++; }, () => busy, () => {}, () => 5);
        queue.request(); await pause(); expect(runs).to.equal(0);
        busy = false; await pause(); expect(runs).to.equal(1);
        queue.request(); queue.dispose(); await pause(); expect(runs).to.equal(1);
    });
    it('reports failure once and retries on the next save instead of looping', async () => {
        let runs = 0, errors = 0;
        const queue = new SaveUploadQueue(async () => { runs++; if (runs === 1) { throw new Error('Permission denied'); } },
            () => false, () => { errors++; }, () => 5);
        try {
            queue.request(); await pause(); expect(errors).to.equal(1); expect(runs).to.equal(1);
            queue.request(); await pause(); expect(runs).to.equal(2);
        } finally { queue.dispose(); }
    });
    it('automatically retries transient errors and stops at its retry limit', async () => {
        let runs = 0, errors = 0;
        const queue = new SaveUploadQueue(async () => { runs++; throw new Error('offline'); },
            () => false, () => { errors++; }, () => 1, 5, 2);
        try {
            queue.request(); await pause();
            expect(runs).to.equal(3); expect(errors).to.equal(1);
            await pause(); expect(runs).to.equal(3);
            queue.request(); await pause(); expect(runs).to.equal(6);
        } finally { queue.dispose(); }
    });
    it('recovers automatically and disposal cancels a scheduled retry', async () => {
        let runs = 0;
        const queue = new SaveUploadQueue(async () => { if (++runs === 1) { throw new Error('ECONNRESET'); } },
            () => false, () => { throw new Error('unexpected terminal failure'); }, () => 1, 5);
        queue.request(); await pause(); expect(runs).to.equal(2); queue.dispose();
        const stopped = new SaveUploadQueue(async () => { runs++; throw new Error('offline'); },
            () => false, () => {}, () => 1, 100);
        stopped.request(); await pause(); stopped.dispose(); await pause(); expect(runs).to.equal(3);
    });
    it('does not retry user cancellation or certificate failures', async () => {
        for (const message of ['Transfer cancelled', 'status 255 x509: certificate signed by unknown authority']) {
            let runs = 0;
            const queue = new SaveUploadQueue(async () => { runs++; throw new Error(message); }, () => false, () => {}, () => 1, 1);
            queue.request(); await pause(); queue.dispose(); expect(runs).to.equal(1);
        }
    });

});
