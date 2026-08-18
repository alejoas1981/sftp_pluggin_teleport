import { expect } from 'chai';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SftpConfig } from '../config';
import * as tsh from '../tsh';

const cp: any = require('child_process');

let originalSpawn: any;
let tempDir: string;
let originalPath: string | undefined;

interface FakeChild extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
}

function createFakeChild(stdout = '', stderr = '', exitCode = 0): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
        if (stdout) { child.stdout.emit('data', Buffer.from(stdout)); }
        if (stderr) { child.stderr.emit('data', Buffer.from(stderr)); }
        child.emit('close', exitCode);
    });
    return child;
}

function createFailingChild(error: Error): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => { child.emit('error', error); });
    return child;
}

function createTshExecutable(dir: string, name = 'tsh'): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, '#!/bin/sh\necho ok', { mode: 0o755 });
    return full;
}

describe('tsh', () => {
    beforeEach(() => {
        tsh.resetTshCache();
        originalSpawn = cp.spawn;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsh-test-'));
        originalPath = process.env.PATH;
        process.env.PATH = `${tempDir}${path.delimiter}${process.env.PATH}`;
    });

    afterEach(() => {
        cp.spawn = originalSpawn;
        process.env.PATH = originalPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('findInPath', () => {
        it('finds a plain binary on POSIX', () => {
            createTshExecutable(tempDir);
            const found = tsh.findInPath('tsh', 'linux', { PATH: tempDir } as NodeJS.ProcessEnv);
            expect(found).to.equal(path.join(tempDir, 'tsh'));
        });

        it('finds tsh.exe on Windows', () => {
            createTshExecutable(tempDir, 'tsh.exe');
            const found = tsh.findInPath('tsh', 'win32', {
                Path: tempDir,
                PATHEXT: '.EXE;.CMD;.BAT',
            } as unknown as NodeJS.ProcessEnv);
            expect(found).to.equal(path.join(tempDir, 'tsh.exe'));
        });

        it('returns undefined when tsh is not present', () => {
            const found = tsh.findInPath('tsh', 'linux', { PATH: tempDir } as NodeJS.ProcessEnv);
            expect(found).to.be.undefined;
        });
    });

    describe('getTshPath', () => {
        it('throws before initialization', async () => {
            try {
                await tsh.getTshPath();
                expect.fail('expected an error');
            } catch (error: any) {
                expect(error.message).to.include('initialized');
            }
        });

        it('returns the resolved tsh path after initialization', async () => {
            const tshPath = createTshExecutable(tempDir);
            const result = await tsh.initializeTsh(tempDir);
            expect(result).to.equal(tshPath);
            expect(await tsh.getTshPath()).to.equal(tshPath);
        });
    });

    describe('runTshCommand', () => {
        it('returns stdout for successful command', async () => {
            cp.spawn = () => createFakeChild('hello\n', '', 0);
            const result = await tsh.runTshCommand(['status'], { tshPath: '/tsh/tsh' });
            expect(result).to.equal('hello');
        });

        it('throws when command exits with error code', async () => {
            cp.spawn = () => createFakeChild('', 'failed', 1);
            try {
                await tsh.runTshCommand(['status'], { tshPath: '/tsh/tsh' });
                expect.fail('expected an error');
            } catch (error: any) {
                expect(error.message).to.equal('failed');
            }
        });

        it('throws on ENOENT when tsh is missing', async () => {
            cp.spawn = () => createFailingChild(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
            try {
                await tsh.runTshCommand(['status'], { tshPath: '/missing/tsh' });
                expect.fail('expected an error');
            } catch (error: any) {
                expect(error.message).to.include('tsh is not installed');
            }
        });
    });

    describe('ensureTeleportSession', () => {
        function baseConfig(): SftpConfig {
            return {
                mode: 'teleport',
                teleportHost: 'proxy.example.com:3080',
                teleportUser: 'dev',
                teleportCluster: 'main',
                sftpHost: 'node.example.com',
                sftpUser: 'ec2-user',
            };
        }

        it('caches an active session', async () => {
            createTshExecutable(tempDir);
            await tsh.initializeTsh(tempDir);
            const spawned: Array<{ command: string; args: string[] }> = [];
            cp.spawn = (command: string, args: string[]) => {
                spawned.push({ command, args });
                return createFakeChild('logged in', '', 0);
            };

            const result = await tsh.ensureTeleportSession(baseConfig());
            expect(result).to.equal('logged in');
            expect(spawned).to.have.length(1);

            const second = await tsh.ensureTeleportSession(baseConfig());
            expect(second).to.equal('logged in');
            expect(spawned).to.have.length(1);
        });

        it('logs in when the session is not active', async () => {
            createTshExecutable(tempDir);
            await tsh.initializeTsh(tempDir);
            const spawned: Array<{ command: string; args: string[] }> = [];
            cp.spawn = (command: string, args: string[]) => {
                spawned.push({ command, args });
                const subcommand = args[0];
                if (subcommand === 'status') {
                    return createFakeChild('not logged in', '', 0);
                }
                return createFakeChild('login ok', '', 0);
            };

            const result = await tsh.ensureTeleportSession(baseConfig());
            expect(result).to.equal('login ok');
            expect(spawned).to.have.length(2);
            expect(spawned[1].args[0]).to.equal('login');
        });
    });

    describe('loginToTeleport', () => {
        it('emits the login link for the user', async () => {
            createTshExecutable(tempDir);
            await tsh.initializeTsh(tempDir);
            const links: string[] = [];
            cp.spawn = () => createFakeChild('Open this URL: https://proxy.example.com/web/login/123', '', 0);

            const config: SftpConfig = {
                mode: 'teleport',
                teleportHost: 'proxy.example.com:3080',
                teleportUser: 'dev',
                teleportCluster: 'main',
                sftpHost: 'node.example.com',
                sftpUser: 'ec2-user',
            };
            await tsh.loginToTeleport(config, {
                onLink: (url: string) => links.push(url),
            });

            expect(links).to.have.length(1);
            expect(links[0]).to.equal('https://proxy.example.com/web/login/123');
        });
    });
});
