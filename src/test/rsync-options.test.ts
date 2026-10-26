import { expect } from 'chai';
import { normalizeRsyncOptions } from '../rsync-options';

describe('legacy rsync options', () => {
    it('preserves quoted exclusions and extracts bandwidth without executing shell text', () => {
        const config = normalizeRsyncOptions({ mode: 'teleport', ignore: ['existing'],
            rsyncFlags: "--exclude .git --exclude '*.log' --exclude='folder with spaces' --exclude=src/cache/ --bwlimit=100" });
        expect(config.ignore).to.deep.equal(['existing', '.git', '*.log', 'folder with spaces', '**/src/cache/']);
        expect(config.rsyncFlags).to.equal('--bwlimit=100');
    });
    it('rejects unsupported flags and malformed exclusions explicitly', () => {
        for (const rsyncFlags of ['--delete', '--exclude', "--exclude 'broken", '--exclude --delete']) {
            expect(() => normalizeRsyncOptions({ mode: 'teleport', rsyncFlags })).to.throw();
        }
    });
    it('does not change other transport configurations', () => {
        const config = { mode: 'ftp' as const, rsyncFlags: '--old-option' };
        expect(normalizeRsyncOptions(config)).to.equal(config);
    });
});
