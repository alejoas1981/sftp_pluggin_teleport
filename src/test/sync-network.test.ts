import { configureStorage } from '../private-storage';
import { expect } from 'chai';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SftpConfig } from '../config';
import * as realCp from 'child_process';
// @ts-ignore
import { loadSync } from '../../test/proxyquire-helper.cjs';

let sftpCalls: string[] = [];
let currentSftp: any = {};

function makeStats(opts: { size?: number; mtime?: number; isDirectory?: boolean }) {
    return {
        size: opts.size ?? 0,
        mtime: opts.mtime ?? 0,
        isDirectory: () => !!opts.isDirectory,
        isSymbolicLink: () => false,
    };
}

class MockSftp {
    client: MockSshClient;
    constructor(client: MockSshClient) {
        this.client = client;
    }

    stat(p: string, cb: any) {
        sftpCalls.push(`stat:${p}`);
        const err = currentSftp.statError?.[p];
        if (err) return cb(err);
        const s = currentSftp.stats?.[p];
        if (!s) return cb({ code: 2, message: 'No such file' });
        cb(null, s);
    }

    lstat(p: string, cb: any) { this.stat(p, cb); }

    readdir(p: string, cb: any) {
        sftpCalls.push(`readdir:${p}`);
        cb(null, currentSftp.readdir?.[p] || []);
    }

    fastPut(local: string, remote: string, cb: any) {
        sftpCalls.push(`fastPut:${local}:${remote}`);
        if (!currentSftp.fastPutError) {
            currentSftp.stats = currentSftp.stats || {};
            currentSftp.stats[remote] = makeStats({ size: fs.statSync(local).size, mtime: 1800000000 });
            if (currentSftp.statError) { delete currentSftp.statError[remote]; }
        }
        cb(currentSftp.fastPutError);
    }

    fastGet(remote: string, local: string, cb: any) {
        sftpCalls.push(`fastGet:${remote}:${local}`);
        if (!currentSftp.fastGetError) {
            fs.writeFileSync(local, currentSftp.contents?.[remote] ?? 'downloaded');
        }
        cb(currentSftp.fastGetError);
    }

    mkdir(p: string, cb: any) {
        sftpCalls.push(`mkdir:${p}`);
        cb(currentSftp.mkdirError);
    }

    rmdir(p: string, cb: any) {
        sftpCalls.push(`rmdir:${p}`);
        cb(currentSftp.rmdirError);
    }

    unlink(p: string, cb: any) {
        sftpCalls.push(`unlink:${p}`);
        cb(currentSftp.unlinkError);
    }
}

class MockSshClient extends EventEmitter {
    config: any;

    sftp(cb: (err: any, sftp: any) => void) {
        setImmediate(() => cb(null, new MockSftp(this)));
    }

    connect(config: any) {
        this.config = config;
        setImmediate(() => this.emit('ready'));
    }

    end() {}
}

let ftpCalls: string[] = [];
let currentFtp: any = {};

class MockBasicFtpClient {
    accessOpts: any;
    prepareTransfer: any;
    directory = "/";

    async pwd() { return "/"; }

    async access(opts: any) {
        this.accessOpts = opts;
        currentFtp.accessOptions = opts;
        ftpCalls.push('access');
    }

    async list(remoteDir?: string) {
        ftpCalls.push(`list:${remoteDir ?? '.'}`);
        return currentFtp.lists?.[remoteDir ?? '/'] ?? currentFtp.list ?? [];
    }

    async size(remotePath: string) {
        ftpCalls.push(`size:${remotePath}`);
        if (currentFtp.files?.[remotePath]) { return currentFtp.files[remotePath].size; }
        if (currentFtp.size !== undefined) { return currentFtp.size; }
        throw Object.assign(new Error('No such file'), { code: 550 });
    }

    async lastMod(remotePath: string) {
        ftpCalls.push(`lastMod:${remotePath}`);
        return currentFtp.files?.[remotePath]?.time ?? currentFtp.lastMod ?? new Date(0);
    }

    async ensureDir(dir: string) {
        ftpCalls.push(`ensureDir:${dir}`);
        this.directory = dir;
    }

    async uploadFrom(localPath: string, remoteName: string) {
        ftpCalls.push(`uploadFrom:${localPath}:${remoteName}`);
        currentFtp.files = currentFtp.files || {};
        currentFtp.files[path.posix.join(this.directory, remoteName)] = { size: fs.statSync(localPath).size, time: new Date(1800000000000) };
    }

    async downloadTo(localPath: string, remoteName: string) {
        ftpCalls.push(`downloadTo:${localPath}:${remoteName}`);
        fs.writeFileSync(localPath, currentFtp.files?.[remoteName]?.content ?? 'downloaded');
    }

    async remove(name: string, _recursive: boolean) {
        ftpCalls.push(`remove:${name}`);
    }

    close() {
        ftpCalls.push('close');
    }
}

class SerialOnlyFtpClient extends MockBasicFtpClient {
    private busy = false;

    constructor() {
        super();
        for (const method of ['access', 'pwd', 'list', 'size', 'lastMod', 'ensureDir', 'uploadFrom', 'downloadTo', 'remove'] as const) {
            const operation = (this[method] as Function).bind(this);
            (this as any)[method] = async (...args: unknown[]) => {
                if (this.busy) {
                    const error = new Error("User launched a task while another one is still running. Forgot to use 'await' or '.then()'?");
                    currentFtp.overlap = error;
                    throw error;
                }
                this.busy = true;
                const transferring = method === 'downloadTo' || method === 'uploadFrom';
                if (transferring) {
                    currentFtp.active = (currentFtp.active ?? 0) + 1;
                    currentFtp.peak = Math.max(currentFtp.peak ?? 0, currentFtp.active);
                }
                try {
                    await new Promise<void>((resolve) => transferring ? setTimeout(resolve, 40) : setImmediate(resolve));
                    return await operation(...args);
                } finally {
                    this.busy = false;
                    if (transferring) { currentFtp.active--; }
                }
            };
        }
    }
}

function buildSftpConfig(overrides: Partial<SftpConfig> = {}): SftpConfig {
    return {
        mode: 'sftp',
        sftpHost: 'h',
        sftpUser: 'u',
        sftpPort: 22,
        remotePath: '/remote',
        localPath: '',
        concurrency: 1,
        ignore: [],
        ...overrides,
    };
}

describe('sync network', () => {
    let tempDir: string, storageRoot: string;
    let sync: any;

    beforeEach(() => {
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'network-storage-'));
        configureStorage(storageRoot);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-net-'));
        sftpCalls = [];
        currentSftp = {};
        ftpCalls = [];
        currentFtp = {};
        sync = loadSync({ 'ssh2': { Client: MockSshClient } });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageRoot, { recursive: true, force: true });
    });

    it('runSync sftp dry-run returns DRY RUN report', async () => {
        fs.writeFileSync(path.join(tempDir, 'a.txt'), 'a');
        currentSftp = {
            stats: { '/remote': makeStats({ isDirectory: true }) },
            readdir: { '/remote': [] },
        };

        const config = buildSftpConfig({ localPath: tempDir });
        const result = await sync.runSync(config, { dryRun: true });

        expect(result).to.include('DRY RUN');
        expect(sftpCalls).to.include('readdir:/remote');
    });

    it('uploadFile sftp puts a single file', async () => {
        const file = path.join(tempDir, 'a.txt');
        fs.writeFileSync(file, 'a');
        currentSftp = {
            stats: { '/remote': makeStats({ isDirectory: true }) },
        };

        const config = buildSftpConfig({ localPath: tempDir });
        await sync.uploadFile(config, file);

        expect(sftpCalls).to.include(`fastPut:${file}:/remote/a.txt`);
    });

    it('downloadFile sftp gets a single file', async () => {
        const local = path.join(tempDir, 'a.txt');
        currentSftp = { stats: { '/remote/a.txt': makeStats({ size: 10, mtime: 1700000000 }) } };

        const config = buildSftpConfig({ localPath: tempDir });
        await sync.downloadFile(config, local);

        expect(sftpCalls.some((call) => call.startsWith('fastGet:/remote/a.txt:'))).to.equal(true);
        expect(fs.existsSync(local)).to.be.true;
        expect(fs.readFileSync(local, 'utf8')).to.equal('downloaded');
    });

    it('deleteRemoteFile sftp unlinks a file', async () => {
        const file = path.join(tempDir, 'a.txt');
        fs.writeFileSync(file, 'a');
        currentSftp = {
            stats: { '/remote/a.txt': makeStats({ isDirectory: false }) },
        };

        const config = buildSftpConfig({ localPath: tempDir });
        await sync.deleteRemoteFile(config, file);

        expect(sftpCalls).to.include('unlink:/remote/a.txt');
    });

    it('syncFile sftp uploads when remote is missing', async () => {
        const file = path.join(tempDir, 'a.txt');
        fs.writeFileSync(file, 'a');
        currentSftp = {
            stats: {},
            statError: { '/remote/a.txt': { code: 2, message: 'No such file' } },
        };

        const config = buildSftpConfig({ localPath: tempDir });
        const result = await sync.syncFile(config, file);

        expect(result).to.include('Upload: 1');
        expect(sftpCalls).to.include(`fastPut:${file}:/remote/a.txt`);
    });

    it('testConnection sftp returns success', async () => {
        currentSftp = { readdir: { '.': [] } };

        const config = buildSftpConfig({ localPath: tempDir });
        const result = await sync.testConnection(config);

        expect(result).to.equal('Connection successful');
        expect(sftpCalls).to.include('readdir:.');
    });

    it('runSync ftp dry-run returns DRY RUN report', async () => {
        fs.writeFileSync(path.join(tempDir, 'b.txt'), 'b');
        currentFtp = { list: [] };

        const ftpSync = loadSync({
            'basic-ftp': { Client: MockBasicFtpClient, enterPassiveModeIPv4: 'mock' },
        });
        const config = buildSftpConfig({
            mode: 'ftp',
            ftpHost: 'h',
            ftpUser: 'u',
            ftpPassive: true,
            localPath: tempDir,
        });

        const result = await ftpSync.runSync(config, { dryRun: true });

        expect(result).to.include('DRY RUN');
        expect(ftpCalls).to.include('list:/remote');
    });

    for (const secure of [false, true]) {
        it(`runs FTP transfers on separate serialized connections with concurrency 4 (TLS: ${secure})`, async () => {
            for (const name of ['a.txt', 'b.txt', 'c.txt']) {
                fs.writeFileSync(path.join(tempDir, name), name);
            }
            const ftpSync = loadSync({ 'basic-ftp': { Client: SerialOnlyFtpClient } }),
                config = buildSftpConfig({ mode: 'ftp', ftpHost: 'h', ftpUser: 'u',
                    ftpSecure: secure, concurrency: 4, localPath: tempDir }),
                result = await ftpSync.runSync(config);

            expect(result).to.include('Upload: 3');
            expect(currentFtp.overlap).to.equal(undefined);
            expect(currentFtp.peak).to.be.greaterThan(1).and.at.most(4);
            expect(ftpCalls.filter((call) => call === 'close').length).to.equal(ftpCalls.filter((call) => call === 'access').length);
            expect(ftpCalls.filter((call) => call.startsWith('uploadFrom:'))).to.have.length(3);
        });
    }

    it('downloads multiple files concurrently and respects sequential mode', async () => {
        for (const concurrency of [1, 3]) {
            currentFtp = { lists: { '/remote': [] }, files: {} };
            for (let i = 0; i < 9; i++) {
                const name = `file-${concurrency}-${i}.txt`;
                currentFtp.lists['/remote'].push({ name, size: 1, modifiedAt: new Date(1700000000000), isDirectory: false });
                currentFtp.files[`/remote/${name}`] = { size: 1, time: new Date(1700000000000), content: 'x' };
            }
            const ftpSync = loadSync({ 'basic-ftp': { Client: SerialOnlyFtpClient } });
            await ftpSync.runSync(buildSftpConfig({ mode: 'ftp', ftpHost: 'h', ftpUser: 'u', localPath: tempDir, concurrency }));
            expect(currentFtp.peak).to.equal(concurrency);
            expect(currentFtp.overlap).to.equal(undefined);
            for (let i = 0; i < 9; i++) { fs.unlinkSync(path.join(tempDir, `file-${concurrency}-${i}.txt`)); }
        }
    });

    it('serializes FTP metadata requests without treating an existing file as missing', async () => {
        const file = path.join(tempDir, 'a.txt');
        fs.writeFileSync(file, 'a');
        currentFtp = { size: 1, lastMod: fs.statSync(file).mtime, list: [{ name: 'a.txt', size: 1, modifiedAt: fs.statSync(file).mtime, isDirectory: false }] };
        const ftpSync = loadSync({ 'basic-ftp': { Client: SerialOnlyFtpClient } }),
            config = buildSftpConfig({ mode: 'ftp', ftpHost: 'h', ftpUser: 'u', localPath: tempDir });

        await ftpSync.uploadFile(config, file);

        expect(currentFtp.overlap, currentFtp.overlap?.message).to.equal(undefined);
        expect(ftpCalls).to.include('size:/remote/a.txt');
        expect(ftpCalls).to.include('lastMod:/remote/a.txt');
    });

    it('imports a nested FTP project using a relative root and passive TLS', async () => {
        currentFtp = {
            lists: {
                '/remote': [{ name: 'assets', size: 0, isDirectory: true }],
                '/remote/assets': [{ name: 'site.txt', size: 7, isDirectory: false, modifiedAt: new Date(1700000000000) }],
            },
            files: { '/remote/assets/site.txt': { content: 'project', size: 7, time: new Date(1700000000000) } },
        };
        const ftp = loadSync({ 'basic-ftp': { Client: SerialOnlyFtpClient, enterPassiveModeIPv4: 'passive' } }),
            config = buildSftpConfig({ mode: 'ftp', ftpHost: 'h', ftpUser: 'u', ftpSecure: true, ftpPassive: true,
                localPath: tempDir, remotePath: 'remote' });
        await ftp.runSync(config);
        expect(fs.readFileSync(path.join(tempDir, 'assets/site.txt'), 'utf8')).to.equal('project');
        expect(currentFtp.accessOptions.secure).to.equal(true);
        expect(ftpCalls.some((call) => call.startsWith('ensureDir:') || call.startsWith('remove:'))).to.equal(false);
        expect(currentFtp.overlap).to.equal(undefined);
    });

    it('imports an SFTP project without writing to the server', async () => {
        currentSftp = {
            readdir: { '/remote': [{ filename: 'site.txt', attrs: makeStats({ size: 7, mtime: 1700000000 }) }] },
            stats: { '/remote/site.txt': makeStats({ size: 7, mtime: 1700000000 }) },
            contents: { '/remote/site.txt': 'project' },
        };
        await sync.runSync(buildSftpConfig({ localPath: tempDir }));
        expect(fs.readFileSync(path.join(tempDir, 'site.txt'), 'utf8')).to.equal('project');
        expect(sftpCalls.some((call) => call.startsWith('fastPut:') || call.startsWith('unlink:') || call.startsWith('mkdir:'))).to.equal(false);
    });

    for (const dryRun of [true, false]) {
        it(`imports through the Teleport adapter (dry run: ${dryRun})`, async () => {
            const calls: Array<{ command: string; args: string[] }> = [],
                logs: string[] = [],
                childFactory = (command: string, args: string[]) => {
                    const child = new EventEmitter() as any;
                    child.stdout = new EventEmitter();
                    child.stderr = new EventEmitter();
                    calls.push({ command, args });
                    setImmediate(() => {
                        if (command === 'tsh') {
                            const remoteCommand = args[args.length - 1];
                            if (remoteCommand.includes('find ')) {
                                child.stdout.emit('data', 'server.txt\0' + '7\0' + '1700000000\0f\0');
                            } else if (remoteCommand.includes('stat ')) {
                                child.stdout.emit('data', '7 1700000000 regular file');
                            } else { child.stdout.emit('data', 'Logged in'); }
                        } else if (command === 'rsync') {
                            expect(logs.join('')).to.include('DOWNLOAD server to local: server.txt — started');
                            fs.writeFileSync(args[args.length - 1], 'project');
                        }
                        child.emit('close', 0);
                    });
                    return child;
                },
                teleport = loadSync({ './teleport-installer': { ensureTsh: async () => 'tsh' },
                    'child_process': { ...realCp, spawn: childFactory } }),
                config = buildSftpConfig({ mode: 'teleport', teleportHost: 'proxy', teleportUser: 'user',
                    localPath: tempDir, remotePath: '/remote' }),
                result = await teleport.runSync(config, { dryRun, onLog: (text: string) => logs.push(text) });
            expect(result).to.include('Download: 1');
            expect(calls.some((call) => call.args.includes('--delete'))).to.equal(false);
            if (dryRun) {
                expect(calls.some((call) => call.command === 'rsync')).to.equal(false);
                expect(fs.readdirSync(tempDir)).to.have.length(0);
            } else {
                expect(fs.readFileSync(path.join(tempDir, 'server.txt'), 'utf8')).to.equal('project');
                expect(logs.join('')).to.include('DOWNLOAD server to local: server.txt — done');
            }
        });
    }
});
