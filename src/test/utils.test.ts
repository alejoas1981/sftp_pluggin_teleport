import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    normalizeRemotePath,
    joinRemote,
    joinLocal,
    isIgnored,
    ensureLocalDir,
    resolveKeyValue,
    resolvePrivateKey,
} from '../utils';

describe('utils', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('normalizeRemotePath', () => {
        it('returns dot for empty input', () => {
            expect(normalizeRemotePath('')).to.equal('.');
        });

        it('returns root for root input', () => {
            expect(normalizeRemotePath('/')).to.equal('/');
        });

        it('returns dot for dot input', () => {
            expect(normalizeRemotePath('.')).to.equal('.');
        });

        it('strips trailing slashes', () => {
            expect(normalizeRemotePath('/home/project/')).to.equal('/home/project');
        });

        it('resolves relative segments', () => {
            expect(normalizeRemotePath('/home/project/../other')).to.equal('/home/other');
        });
    });

    describe('joinRemote', () => {
        it('joins remote segments with posix separator', () => {
            expect(joinRemote('/home', 'project', 'file.txt')).to.equal('/home/project/file.txt');
        });

        it('normalizes trailing slashes', () => {
            expect(joinRemote('/home/', 'project/')).to.equal('/home/project');
        });
    });

    describe('joinLocal', () => {
        it('joins local segments', () => {
            expect(joinLocal('home', 'project', 'file.txt')).to.equal(path.normalize('home/project/file.txt'));
        });
    });

    describe('isIgnored', () => {
        it('matches glob patterns', () => {
            expect(isIgnored('debug.log', ['*.log'])).to.be.true;
            expect(isIgnored('src/index.ts', ['*.log'])).to.be.false;
        });

        it('matches directory patterns', () => {
            expect(isIgnored('node_modules/foo/bar.js', ['node_modules/'])).to.be.true;
            expect(isIgnored('src/foo.js', ['node_modules/'])).to.be.false;
        });
    });

    describe('ensureLocalDir', () => {
        it('creates the parent directory for a file path', () => {
            const filePath = path.join(tempDir, 'new', 'dir', 'file.txt');
            ensureLocalDir(filePath);
            expect(fs.existsSync(path.dirname(filePath))).to.be.true;
        });
    });

    describe('resolveKeyValue', () => {
        it('expands leading tilde to homedir', () => {
            const result = resolveKeyValue('~/ssh/id');
            expect(result).to.equal(path.join(os.homedir(), 'ssh/id'));
        });

        it('returns undefined for empty value', () => {
            expect(resolveKeyValue('')).to.be.undefined;
            expect(resolveKeyValue(undefined)).to.be.undefined;
        });

        it('leaves absolute paths unchanged', () => {
            expect(resolveKeyValue('/etc/ssh/id')).to.equal('/etc/ssh/id');
        });
    });

    describe('resolvePrivateKey', () => {
        it('returns raw key content when value contains BEGIN marker', () => {
            const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
            expect(resolvePrivateKey(key)).to.equal(key);
        });

        it('reads key from existing file', () => {
            const keyPath = path.join(tempDir, 'id_rsa');
            fs.writeFileSync(keyPath, 'secret');
            const result = resolvePrivateKey(keyPath);
            expect(result).to.be.an.instanceOf(Buffer);
            expect(result?.toString()).to.equal('secret');
        });

        it('returns path string for missing file', () => {
            const missing = path.join(tempDir, 'missing');
            expect(resolvePrivateKey(missing)).to.equal(missing);
        });

        it('returns undefined for empty value', () => {
            expect(resolvePrivateKey('')).to.be.undefined;
            expect(resolvePrivateKey(undefined)).to.be.undefined;
        });
    });
});
