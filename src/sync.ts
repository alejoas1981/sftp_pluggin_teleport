import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Client as BasicFtpClient, FileInfo as BasicFtpFileInfo } from 'basic-ftp';
import ignore from 'ignore';
import PQueue from 'p-queue';
import { Callback, Client as SshClient, SFTPWrapper } from 'ssh2';
import { resolveMode, SftpConfig } from './config';
import { ensureLocalDir, normalizeRemotePath, resolveKeyValue, resolvePrivateKey } from './utils';

const SESSION_CACHE_MS = 60000;

let cachedSession: { configKey: string; output: string; validUntil: number } | undefined;

export interface SyncOptions {
    dryRun?: boolean;
    cwd?: string;
}

export interface LoginOptions {
    onLink?: (url: string) => void;
}

interface RemoteItem {
    name: string;
    size: number;
    modifyTime: number;
    isDirectory: boolean;
}

interface FileItem {
    rel: string;
    size: number;
    modifyTime: number;
    isDirectory: boolean;
}

interface SyncPlan {
    makeDirs: string[];
    upload: string[];
    remove: string[];
}

interface RemoteClient {
    test(): Promise<void>;
    list(remoteDir: string): Promise<RemoteItem[]>;
    put(localPath: string, remotePath: string): Promise<void>;
    get(remotePath: string, localPath: string): Promise<void>;
    mkdir(remotePath: string): Promise<void>;
    delete(remotePath: string): Promise<void>;
    close(): Promise<void>;
}

class SftpClient implements RemoteClient {
    private config: SftpConfig;
    private client?: SshClient;
    private sftp?: SFTPWrapper;

    constructor(config: SftpConfig) {
        this.config = config;
    }

    async test(): Promise<void> {
        await this.connect();
        await this.list('.');
    }

    async list(remoteDir: string): Promise<RemoteItem[]> {
        const sftp = await this.connect();
        return new Promise<RemoteItem[]>((resolve, reject) => {
            sftp.readdir(remoteDir, (err, list) => {
                if (err) {
                    const code = (err as any).code;
                    if (code === 2 || /NO_SUCH_FILE|No such file/i.test(err.message)) {
                        resolve([]);
                    } else {
                        reject(err);
                    }
                    return;
                }
                resolve(list.map((e) => ({
                    name: e.filename,
                    size: e.attrs.size,
                    modifyTime: e.attrs.mtime * 1000,
                    isDirectory: e.attrs.isDirectory(),
                })));
            });
        });
    }

    async put(localPath: string, remotePath: string): Promise<void> {
        const sftp = await this.connect();
        await this.ensureRemoteDir(path.posix.dirname(remotePath));
        return new Promise<void>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
        });
    }

    async get(remotePath: string, localPath: string): Promise<void> {
        const sftp = await this.connect();
        ensureLocalDir(localPath);
        return new Promise<void>((resolve, reject) => {
            sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
        });
    }

    async mkdir(remotePath: string): Promise<void> {
        const sftp = await this.connect();
        await this.ensureRemoteDir(remotePath);
    }

    async delete(remotePath: string): Promise<void> {
        const sftp = await this.connect();
        const stats = await this.sftpStat(remotePath);
        if (!stats) {
            return;
        }
        return new Promise<void>((resolve, reject) => {
            const cb: Callback = (err) => (err ? reject(err) : resolve());
            stats.isDirectory() ? sftp.rmdir(remotePath, cb) : sftp.unlink(remotePath, cb);
        });
    }

    async close(): Promise<void> {
        if (this.client) {
            this.client.end();
            this.client = undefined;
            this.sftp = undefined;
        }
    }

    private async connect(): Promise<SFTPWrapper> {
        if (this.sftp) {
            return this.sftp;
        }
        this.client = new SshClient();
        const config = this.buildConfig();
        return new Promise<SFTPWrapper>((resolve, reject) => {
            this.client!.once('error', (err) => reject(err));
            this.client!.once('ready', () => {
                this.client!.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this.client!.removeAllListeners('error');
                    this.sftp = sftp;
                    resolve(sftp);
                });
            });
            this.client!.connect(config);
        });
    }

    private buildConfig(): any {
        const cfg: any = {
            host: this.config.sftpHost,
            port: this.config.sftpPort ?? 22,
            username: this.config.sftpUser,
        };
        if (this.config.password) {
            cfg.password = this.config.password;
        }
        const key = resolvePrivateKey(this.config.privateKey ?? this.config.identity);
        if (key) {
            cfg.privateKey = key;
        }
        if (this.config.passphrase) {
            cfg.passphrase = this.config.passphrase;
        }
        const agent = resolveKeyValue(this.config.agent);
        if (agent) {
            cfg.agent = agent;
        }
        return cfg;
    }

    private async sftpStat(remotePath: string): Promise<import('ssh2').Stats | undefined> {
        const sftp = await this.connect();
        return new Promise<import('ssh2').Stats | undefined>((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) {
                    const code = (err as any).code;
                    if (code === 2 || /NO_SUCH_FILE|No such file/i.test(err.message)) {
                        resolve(undefined);
                    } else {
                        reject(err);
                    }
                    return;
                }
                resolve(stats);
            });
        });
    }

    private async ensureRemoteDir(dir: string): Promise<void> {
        if (dir === '' || dir === '/' || dir === '.') {
            return;
        }
        const sftp = await this.connect();
        const exists = await this.dirExists(dir);
        if (exists) {
            return;
        }
        const parent = path.posix.dirname(dir);
        if (parent !== dir) {
            await this.ensureRemoteDir(parent);
        }
        return new Promise<void>((resolve, reject) => {
            sftp.mkdir(dir, (err) => (err ? reject(err) : resolve()));
        });
    }

    private async dirExists(dir: string): Promise<boolean> {
        const sftp = await this.connect();
        return new Promise<boolean>((resolve, reject) => {
            sftp.stat(dir, (err, stats) => {
                if (err) {
                    const code = (err as any).code;
                    if (code === 2 || /NO_SUCH_FILE|No such file/i.test(err.message)) {
                        resolve(false);
                    } else {
                        reject(err);
                    }
                    return;
                }
                resolve(stats.isDirectory());
            });
        });
    }
}

class FtpClient implements RemoteClient {
    private config: SftpConfig;
    private client: BasicFtpClient;
    private connected = false;

    constructor(config: SftpConfig) {
        this.config = config;
        this.client = new BasicFtpClient();
    }

    async test(): Promise<void> {
        await this.connect();
        await this.client.list();
    }

    async list(remoteDir: string): Promise<RemoteItem[]> {
        await this.connect();
        const list = remoteDir === '.' || !remoteDir
            ? await this.client.list()
            : await this.client.list(remoteDir);
        return list.map(this.mapFileInfo);
    }

    async put(localPath: string, remotePath: string): Promise<void> {
        await this.connect();
        const parent = path.posix.dirname(remotePath);
        await this.client.ensureDir(parent);
        const base = path.posix.basename(remotePath);
        await this.client.uploadFrom(localPath, base);
    }

    async get(remotePath: string, localPath: string): Promise<void> {
        await this.connect();
        ensureLocalDir(localPath);
        const parent = path.posix.dirname(remotePath);
        await this.client.ensureDir(parent);
        const base = path.posix.basename(remotePath);
        await this.client.downloadTo(localPath, base);
    }

    async mkdir(remotePath: string): Promise<void> {
        await this.connect();
        await this.client.ensureDir(remotePath);
    }

    async delete(remotePath: string): Promise<void> {
        await this.connect();
        const parent = path.posix.dirname(remotePath);
        await this.client.ensureDir(parent);
        const base = path.posix.basename(remotePath);
        await this.client.remove(base, true);
    }

    async close(): Promise<void> {
        this.client.close();
        this.connected = false;
    }

    private async connect(): Promise<void> {
        if (this.connected) {
            return;
        }
        await this.client.access({
            host: this.config.ftpHost,
            port: this.config.ftpPort ?? 21,
            user: this.config.ftpUser,
            password: this.config.password,
            secure: this.config.ftpSecure ?? false,
        });
        this.connected = true;
    }

    private mapFileInfo(info: BasicFtpFileInfo): RemoteItem {
        return {
            name: info.name,
            size: info.size,
            modifyTime: info.modifiedAt ? info.modifiedAt.getTime() : 0,
            isDirectory: info.isDirectory,
        };
    }
}

function createRemoteClient(config: SftpConfig): RemoteClient {
    return resolveMode(config) === 'ftp' ? new FtpClient(config) : new SftpClient(config);
}

class SyncEngine {
    private config: SftpConfig;

    constructor(config: SftpConfig) {
        this.config = config;
    }

    async sync(client: RemoteClient, options: SyncOptions = {}): Promise<string> {
        const localRoot = this.config.localPath!;
        const remoteRoot = normalizeRemotePath(this.config.remotePath!);
        const concurrency = this.config.concurrency ?? 4;
        const ig = ignore().add(this.config.ignore ?? []);
        const queue = new PQueue({ concurrency });

        await client.mkdir(remoteRoot);

        const [localFiles, remoteFiles] = await Promise.all([
            this.collectLocalFiles(localRoot, ig),
            this.collectRemoteFiles(client, remoteRoot, queue, ig),
        ]);

        const plan = this.buildPlan(localFiles, remoteFiles);
        const report = this.formatReport(plan);

        if (options.dryRun) {
            return `DRY RUN\n${report}`;
        }

        await this.execute(client, plan, queue, localRoot, remoteRoot);
        await queue.onIdle();

        return `SYNC COMPLETE\n${report}`;
    }

    private async collectLocalFiles(localRoot: string, ig: any): Promise<Map<string, FileItem>> {
        const files = new Map<string, FileItem>();

        const walk = async (dir: string, dirRel: string) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
                if (ig.ignores(rel)) {
                    continue;
                }
                const full = path.join(dir, e.name);
                const stat = await fs.promises.stat(full);
                const item: FileItem = {
                    rel,
                    size: stat.size,
                    modifyTime: stat.mtimeMs,
                    isDirectory: stat.isDirectory(),
                };
                files.set(rel, item);
                if (e.isDirectory()) {
                    await walk(full, rel);
                }
            }
        };

        await walk(localRoot, '');
        return files;
    }

    private async collectRemoteFiles(
        client: RemoteClient,
        remoteRoot: string,
        queue: PQueue,
        ig: any
    ): Promise<Map<string, FileItem>> {
        const files = new Map<string, FileItem>();
        const errors: Error[] = [];

        const visit = async (dirRel: string) => {
            const full = dirRel ? path.posix.join(remoteRoot, dirRel) : remoteRoot;
            const entries = await client.list(full);
            for (const e of entries) {
                if (e.name === '.' || e.name === '..') {
                    continue;
                }
                const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
                if (ig.ignores(rel)) {
                    continue;
                }
                if (e.isDirectory) {
                    queue.add(() => visit(rel).catch((err) => errors.push(err)));
                } else {
                    files.set(rel, { rel, size: e.size, modifyTime: e.modifyTime, isDirectory: false });
                }
            }
        };

        queue.add(() => visit('').catch((err) => errors.push(err)));
        await queue.onIdle();

        if (errors.length > 0) {
            throw errors[0];
        }
        return files;
    }

    private buildPlan(localFiles: Map<string, FileItem>, remoteFiles: Map<string, FileItem>): SyncPlan {
        const makeDirs: string[] = [];
        const upload: string[] = [];

        for (const [rel, item] of localFiles) {
            if (item.isDirectory) {
                makeDirs.push(rel);
                continue;
            }
            const remote = remoteFiles.get(rel);
            if (!remote || remote.size !== item.size) {
                upload.push(rel);
                continue;
            }
            const localSeconds = Math.floor(item.modifyTime / 1000);
            const remoteSeconds = Math.floor(remote.modifyTime / 1000);
            if (remoteSeconds > 0 && localSeconds > remoteSeconds) {
                upload.push(rel);
            }
        }

        const remove: string[] = [];
        for (const rel of remoteFiles.keys()) {
            if (!localFiles.has(rel)) {
                remove.push(rel);
            }
        }

        return { makeDirs, upload, remove };
    }

    private async execute(
        client: RemoteClient,
        plan: SyncPlan,
        queue: PQueue,
        localRoot: string,
        remoteRoot: string
    ): Promise<void> {
        const jobs: Promise<void>[] = [];

        for (const d of plan.makeDirs) {
            jobs.push(queue.add(() => client.mkdir(path.posix.join(remoteRoot, d))));
        }
        for (const rel of plan.upload) {
            const localPath = path.join(localRoot, rel);
            const remotePath = path.posix.join(remoteRoot, rel);
            jobs.push(queue.add(() => client.put(localPath, remotePath)));
        }
        for (const rel of plan.remove) {
            jobs.push(queue.add(() => client.delete(path.posix.join(remoteRoot, rel))));
        }

        await Promise.all(jobs);
    }

    private formatReport(plan: SyncPlan): string {
        return [
            `Upload: ${plan.upload.length}`,
            `Delete: ${plan.remove.length}`,
            `Create dirs: ${plan.makeDirs.length}`,
        ].join('\n');
    }
}

export async function runSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    const client = createRemoteClient(config);
    const engine = new SyncEngine(config);
    try {
        return await engine.sync(client, options);
    } finally {
        await client.close();
    }
}

function getRemotePath(config: SftpConfig, localPath: string): string {
    const root = config.localPath!;
    const rel = path.relative(root, localPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || rel === '') {
        throw new Error('File is outside the configured local path');
    }
    return path.posix.join(normalizeRemotePath(config.remotePath!), rel);
}

export async function uploadFile(config: SftpConfig, localPath: string): Promise<void> {
    validateConfig(config);
    const client = createRemoteClient(config);
    try {
        await client.put(localPath, getRemotePath(config, localPath));
    } finally {
        await client.close();
    }
}

export async function downloadFile(config: SftpConfig, localPath: string): Promise<void> {
    validateConfig(config);
    const client = createRemoteClient(config);
    try {
        const remotePath = getRemotePath(config, localPath);
        ensureLocalDir(localPath);
        await client.get(remotePath, localPath);
    } finally {
        await client.close();
    }
}

export async function deleteRemoteFile(config: SftpConfig, localPath: string): Promise<void> {
    validateConfig(config);
    const client = createRemoteClient(config);
    try {
        await client.delete(getRemotePath(config, localPath));
    } finally {
        await client.close();
    }
}

export function testTeleport(_config: SftpConfig): Promise<string> {
    return spawnCommand('tsh', ['status'], { env: process.env });
}

export async function testConnection(config: SftpConfig): Promise<string> {
    const mode = resolveMode(config);
    if (mode === 'teleport') {
        return testTeleport(config);
    }
    if (mode === 'ftp' && !config.ftpHost) {
        throw new Error('FTP host is required');
    }
    if (mode === 'sftp' && (!config.sftpHost || !config.sftpUser)) {
        throw new Error('SFTP host and user are required');
    }
    const client = createRemoteClient(config);
    try {
        await client.test();
        return 'Connection successful';
    } finally {
        await client.close();
    }
}

export function loginToTeleport(config: SftpConfig, options: LoginOptions = {}): Promise<string> {
    const args: string[] = ['login'];
    if (config.teleportHost) {
        args.push(`--proxy=${config.teleportHost}`);
    }
    if (config.teleportUser) {
        args.push(`--user=${config.teleportUser}`);
    }
    if (config.teleportCluster) {
        args.push(config.teleportCluster);
    }

    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn('tsh', args, { env: process.env });
        let stdout = '', stderr = '';

        const handleData = (data: Buffer): string => {
            const text = data.toString();
            if (options.onLink) {
                const proxyHost = config.teleportHost
                    ? config.teleportHost.replace(/^https?:\/\//, '').split('/')[0]
                    : undefined;
                const matches = text.match(/https?:\/\/[^\s]+/g);
                const url = matches?.find((u) => !proxyHost || u.includes(proxyHost));
                if (url) {
                    options.onLink(url);
                }
            }
            return text;
        };

        child.stdout.on('data', (data) => { stdout += handleData(data); });
        child.stderr.on('data', (data) => { stderr += handleData(data); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const message = stderr.trim() || stdout.trim() || `tsh login exited with code ${code}`;
                reject(new Error(message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

export async function ensureTeleportSession(config: SftpConfig, options: LoginOptions = {}): Promise<string> {
    if (resolveMode(config) !== 'teleport') {
        return '';
    }
    const key = `${config.teleportHost}:${config.teleportUser}:${config.teleportCluster}`;
    if (cachedSession && cachedSession.configKey === key && Date.now() < cachedSession.validUntil) {
        return cachedSession.output;
    }
    try {
        const out = await testTeleport(config);
        const lowerOut = out.toLowerCase();
        if (['not logged in', 'expired', 'relogin', 'session expired'].some((msg) => lowerOut.includes(msg))) {
            throw new Error('Teleport session not active');
        }
        cachedSession = { configKey: key, output: out, validUntil: Date.now() + SESSION_CACHE_MS };
        return out;
    } catch {
        const out = await loginToTeleport(config, options);
        cachedSession = { configKey: key, output: out, validUntil: Date.now() + SESSION_CACHE_MS };
        return out;
    }
}

export function validateConfig(config: SftpConfig): void {
    const mode = resolveMode(config);
    const missing: string[] = [];
    if (mode === 'teleport') {
        if (!config.teleportHost) { missing.push('teleportHost'); }
        if (!config.teleportUser) { missing.push('teleportUser'); }
        if (!config.sftpHost) { missing.push('sftpHost'); }
        if (!config.sftpUser) { missing.push('sftpUser'); }
    } else if (mode === 'sftp') {
        if (!config.sftpHost) { missing.push('sftpHost'); }
        if (!config.sftpUser) { missing.push('sftpUser'); }
    } else if (mode === 'ftp') {
        if (!config.ftpHost) { missing.push('ftpHost'); }
        if (!config.ftpUser) { missing.push('ftpUser'); }
    }
    if (!config.remotePath) { missing.push('remotePath'); }
    if (!config.localPath) { missing.push('localPath'); }
    if (missing.length > 0) {
        throw new Error(`Missing required configuration: ${missing.join(', ')}`);
    }
}

function spawnCommand(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn(command, args, { env: options.env, cwd: options.cwd });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('error', (error: any) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error(`${command} is not installed or not in PATH.`));
                return;
            }
            reject(error);
        });
        child.on('close', (code) => {
            if (code !== 0) {
                const message = stderr.trim() || stdout.trim() || `command exited with code ${code}`;
                reject(new Error(message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}
