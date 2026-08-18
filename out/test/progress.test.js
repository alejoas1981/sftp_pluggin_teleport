"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const progress_1 = require("../progress");
describe('progress', () => {
    it('renders 0% empty bar', () => {
        (0, chai_1.expect)((0, progress_1.renderProgress)(0)).to.equal('░░░░░░░░░░ 0%');
    });
    it('renders 100% full bar', () => {
        (0, chai_1.expect)((0, progress_1.renderProgress)(100)).to.equal('██████████ 100%');
    });
    it('renders 50% half bar', () => {
        (0, chai_1.expect)((0, progress_1.renderProgress)(50)).to.equal('█████░░░░░ 50%');
    });
    it('clamps negative percent to 0', () => {
        (0, chai_1.expect)((0, progress_1.renderProgress)(-10)).to.equal('░░░░░░░░░░ 0%');
    });
    it('clamps percent over 100 to 100', () => {
        (0, chai_1.expect)((0, progress_1.renderProgress)(150)).to.equal('██████████ 100%');
    });
    it('getFilledCount rounds correctly', () => {
        (0, chai_1.expect)((0, progress_1.getFilledCount)(0, 10)).to.equal(0);
        (0, chai_1.expect)((0, progress_1.getFilledCount)(5, 10)).to.equal(1);
        (0, chai_1.expect)((0, progress_1.getFilledCount)(50, 10)).to.equal(5);
        (0, chai_1.expect)((0, progress_1.getFilledCount)(100, 10)).to.equal(10);
    });
});
