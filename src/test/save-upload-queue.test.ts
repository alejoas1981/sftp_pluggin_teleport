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
        const queue = new SaveUploadQueue(async () => { runs++; if (runs === 1) { throw new Error('offline'); } },
            () => false, () => { errors++; }, () => 5);
        try {
            queue.request(); await pause(); expect(errors).to.equal(1); expect(runs).to.equal(1);
            queue.request(); await pause(); expect(runs).to.equal(2);
        } finally { queue.dispose(); }
    });
});
