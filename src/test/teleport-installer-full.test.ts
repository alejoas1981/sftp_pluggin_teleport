import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stream from 'stream';
import * as realFs from 'fs';
import * as realHttps from 'https';
import * as realCp from 'child_process';
// @ts-ignore
import { loadTeleportInstaller } from '../../test/proxyquire-helper.cjs';

function dummyResponse() {
    const r = new stream.Readable({
        read() {
            this.push(Buffer.from('tarball'));
            this.push(null);
        }
    });
    (r as any).statusCode = 200;
    (r as any).headers = {};
    return r;
}

function buildStubs(opts: { existsSync?: (p: string) => boolean; execError?: Error | null; execStdout?: string } = {}) {
    const fsMock = { ...realFs, existsSync: opts.existsSync ?? (() => false) };
    const httpsMock = {
        ...realHttps,
        get: (_url: any, cb: any) => {
            cb(dummyResponse());
            return { on: () => {} };
        }
    };
    const cpMock = {
        ...realCp,
        exec: (_cmd: string, cb: any) => cb(opts.execError ?? new Error('not found'), opts.execStdout ?? '', '')
    };
    const tarMock = {
        extract: async (o: any) => {
            const tshPath = path.join(o.cwd, 'tsh');
            fs.writeFileSync(tshPath, '');
        }
    };
    return { fs: fsMock, https: httpsMock, 'child_process': cpMock, tar: tarMock };
}

describe('teleport-installer network', () => {
    let targetDir: string;
    let tshPath: string;

    beforeEach(() => {
        targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-net-'));
        tshPath = path.join(targetDir, 'tsh');
    });

    afterEach(() => {
        fs.rmSync(targetDir, { recursive: true, force: true });
    });

    it('checkTshAvailable returns true for existing local tsh', async () => {
        fs.writeFileSync(tshPath, '');
        const fsMock = { ...realFs, existsSync: (p: string) => p === tshPath };
        const ti = loadTeleportInstaller({ fs: fsMock });

        const result = await ti.checkTshAvailable(targetDir);

        expect(result).to.be.true;
    });

    it('checkTshAvailable returns true when tsh is in PATH', async () => {
        const fsMock = { ...realFs, existsSync: () => false };
        const cpMock = { ...realCp, exec: (_cmd: string, cb: any) => cb(null, 'ok', '') };
        const ti = loadTeleportInstaller({ fs: fsMock, 'child_process': cpMock });

        const result = await ti.checkTshAvailable(targetDir);

        expect(result).to.be.true;
    });

    it('checkTshAvailable returns false when tsh not found', async () => {
        const fsMock = { ...realFs, existsSync: () => false };
        const cpMock = { ...realCp, exec: (_cmd: string, cb: any) => cb(new Error('not found'), '', '') };
        const ti = loadTeleportInstaller({ fs: fsMock, 'child_process': cpMock });

        const result = await ti.checkTshAvailable(targetDir);

        expect(result).to.be.false;
    });

    it('installTeleport downloads, extracts and returns tsh path', async () => {
        const stubs = buildStubs();
        const ti = loadTeleportInstaller(stubs);

        const result = await ti.installTeleport(targetDir);

        expect(result).to.equal(tshPath);
        expect(fs.existsSync(tshPath)).to.be.true;
    });

    it('ensureTsh returns existing local tsh', async () => {
        fs.writeFileSync(tshPath, '');
        const fsMock = { ...realFs, existsSync: (p: string) => p === tshPath };
        const ti = loadTeleportInstaller({ fs: fsMock });

        const result = await ti.ensureTsh(targetDir);

        expect(result).to.equal(tshPath);
    });

    it('ensureTsh installs tsh when missing', async () => {
        const stubs = buildStubs();
        const ti = loadTeleportInstaller(stubs);

        const result = await ti.ensureTsh(targetDir);

        expect(result).to.equal(tshPath);
        expect(fs.existsSync(tshPath)).to.be.true;
    });

    it('getTshVersion returns tsh --version output', async () => {
        fs.writeFileSync(tshPath, '');
        const fsMock = { ...realFs, existsSync: (p: string) => p === tshPath };
        const cpMock = { ...realCp, exec: (_cmd: string, cb: any) => cb(null, 'Teleport v15.0.0', '') };
        const ti = loadTeleportInstaller({ fs: fsMock, 'child_process': cpMock });

        const result = await ti.getTshVersion(targetDir);

        expect(result).to.equal('Teleport v15.0.0');
    });
});
