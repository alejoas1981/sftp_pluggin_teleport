import { expect } from 'chai';
import { getFilledCount, renderProgress } from '../progress';

describe('progress', () => {
    it('renders 0% empty bar', () => {
        expect(renderProgress(0)).to.equal('░░░░░░░░░░ 0%');
    });

    it('renders 100% full bar', () => {
        expect(renderProgress(100)).to.equal('██████████ 100%');
    });

    it('renders 50% half bar', () => {
        expect(renderProgress(50)).to.equal('█████░░░░░ 50%');
    });

    it('clamps negative percent to 0', () => {
        expect(renderProgress(-10)).to.equal('░░░░░░░░░░ 0%');
    });

    it('clamps percent over 100 to 100', () => {
        expect(renderProgress(150)).to.equal('██████████ 100%');
    });

    it('getFilledCount rounds correctly', () => {
        expect(getFilledCount(0, 10)).to.equal(0);
        expect(getFilledCount(5, 10)).to.equal(1);
        expect(getFilledCount(50, 10)).to.equal(5);
        expect(getFilledCount(100, 10)).to.equal(10);
    });
});
