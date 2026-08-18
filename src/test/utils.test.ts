import { expect } from 'chai';
import { DEFAULT_IGNORE_PATTERNS, escapeShell, getIgnorePatterns } from '../utils';

describe('utils', () => {
    describe('getIgnorePatterns', () => {
        it('returns defaults when no user patterns are supplied', () => {
            const result = getIgnorePatterns();
            expect(result).to.deep.equal(DEFAULT_IGNORE_PATTERNS);
        });

        it('appends user patterns to defaults', () => {
            const result = getIgnorePatterns(['*.tmp', 'dist/']);
            expect(result.slice(0, DEFAULT_IGNORE_PATTERNS.length)).to.deep.equal(DEFAULT_IGNORE_PATTERNS);
            expect(result).to.include('*.tmp');
            expect(result).to.include('dist/');
        });
    });

    describe('escapeShell', () => {
        it('wraps plain arguments in single quotes', () => {
            expect(escapeShell('/home/user/file')).to.equal("'/home/user/file'");
        });

        it('escapes embedded single quotes', () => {
            expect(escapeShell("it's")).to.equal("'it'\\''s'");
        });
    });
});
