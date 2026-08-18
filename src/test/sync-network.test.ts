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

    readdir(p: string, cb: any) {
        sftpCalls.push(`readdir:${p}`);
        cb(null, currentSftp.readdir?.[p] || []);
    }

    fastPut(local: string, remote: string, cb: any) {
        sftpCalls.push(`fastPut:${local}:${remote}`);
        cb(currentSftp.fastPutError);
    }

    fastGet(remote: string, local: string, cb: any) {
        sftpCalls.push(`fastGet:${remote}:${local}`);
        if (!currentSftp.fastGetError) {
            fs.writeFileSync(local, 'downloaded');
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

    async access(opts: any) {
        this.accessOpts = opts;
        ftpCalls.push('access');
    }

    async list(remoteDir?: string) {
        ftpCalls.push(`list:${remoteDir ?? '.'}`);
        return currentFtp.list || [];
    }

    async size(remotePath: string) {
        ftpCalls.push(`size:${remotePath}`);
        return currentFtp.size ?? 0;
    }

    async lastMod(remotePath: string) {
        ftpCalls.push(`lastMod:${remotePath}`);
        return currentFtp.lastMod ?? new Date(0);
    }

    async ensureDir(dir: string) {
        ftpCalls.push(`ensureDir:${dir}`);
    }

    async uploadFrom(localPath: string, remoteName: string) {
        ftpCalls.push(`uploadFrom:${localPath}:${remoteName}`);
    }

    async downloadTo(localPath: string, remoteName: string) {
        ftpCalls.push(`downloadTo:${localPath}:${remoteName}`);
        fs.writeFileSync(localPath, 'downloaded');
    }

    async remove(name: string, _recursive: boolean) {
        ftpCalls.push(`remove:${name}`);
    }

    close() {
        ftpCalls.push('close');
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
    let tempDir: string;
    let sync: any;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-net-'));
        sftpCalls = [];
        currentSftp = {};
        ftpCalls = [];
        currentFtp = {};
        sync = loadSync({ 'ssh2': { Client: MockSshClient } });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
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
        currentSftp = {};

        const config = buildSftpConfig({ localPath: tempDir });
        await sync.downloadFile(config, local);

        expect(sftpCalls).to.include(`fastGet:/remote/a.txt:${local}`);
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

        expect(result).to.equal('Uploaded (remote missing)');
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

    it('runSync teleport dry-run returns DRY RUN report', async () => {
        const childFactory = (cmd: string, _args: string[], _opts: any) => {
            const child = new EventEmitter() as any;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            setImmediate(() => {
                if (cmd === 'tsh') {
                    child.stdout.emit('data', 'Logged in');
                    child.emit('close', 0);
                } else if (cmd === 'rsync') {
                    child.stdout.emit('data', 'Number of files transferred: 0\nTotal transferred file size: 0');
                    child.emit('close', 0);
                } else {
                    child.emit('error', new Error('unknown'));
                }
            });
            return child;
        };
        const cpMock = { ...realCp, spawn: childFactory };
        const tpSync = loadSync({
            './teleport-installer': { ensureTsh: async () => 'tsh' },
            'child_process': cpMock,
        });

        const config = buildSftpConfig({
            mode: 'teleport',
            teleportHost: 'tp.example.com',
            teleportUser: 'dev',
            sftpHost: 's',
            sftpUser: 'u',
            localPath: tempDir,
            remotePath: '/remote',
        });

        const result = await tpSync.runSync(config, { dryRun: true });

        expect(result).to.include('DRY RUN');
    });
});
