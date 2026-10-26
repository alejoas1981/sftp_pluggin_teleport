import { normalizeRsyncOptions } from './rsync-options';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Client as BasicFtpClient, enterPassiveModeIPv4, FileInfo as BasicFtpFileInfo } from 'basic-ftp';
import PQueue from 'p-queue';
import { Callback, Client as SshClient, SFTPWrapper } from 'ssh2';
import { resolveMode, SftpConfig } from './config';
import { ensureLocalDir, normalizeRemotePath, resolveKeyValue, resolvePrivateKey, transferConcurrency } from './utils';
import { ensureTsh } from './teleport-installer';
import { SyncEngine } from './sync-engine';
import type { SyncProgress } from './sync-task';
export { SyncEngine } from './sync-engine';

const SESSION_CACHE_MS = 60000,
    remoteActionQueue = new PQueue({ concurrency: 1 });

let cachedSession: { configKey: string; output: string; validUntil: number } | undefined,
    activeTransferController: AbortController | undefined;

export interface TransferPath {
    localPath: string;
    remotePath: string;
}

export function cancelActiveTransfer(): boolean {
    if (!activeTransferController || activeTransferController.signal.aborted) { return false; }
    activeTransferController.abort();
    return true;
}

/**
 * Checks whether the given error represents a missing file.
 * @param err - The error to inspect.
 * @returns {boolean} True when the error indicates no such file.
 */
function isMissingError(err: any): boolean {
    const code = err.code;
    if (code === 2) {
        return true;
    }
    return /NO_SUCH_FILE|No such file/i.test(err.message);
}

export interface SyncOptions {
    onState?: (state: Partial<SyncProgress>) => void;
    dryRun?: boolean;
    files?: string[];
    onLog?: (text: string) => void;
    cwd?: string;
    onProgress?: (current: number, total: number, file: string, action: string) => void;
}

export interface LoginOptions {
    onLink?: (url: string) => void;
}

export interface RemoteItem {
    name: string;
    size: number;
    modifyTime: number;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
}

export interface RemoteClient {
    test(): Promise<void>;
    list(remoteDir: string): Promise<RemoteItem[]>;
    stat(remotePath: string): Promise<RemoteItem | undefined>;
    statMany?(remotePaths: string[]): Promise<Map<string, RemoteItem | undefined>>;
    put(localPath: string, remotePath: string): Promise<void>;
    putMany?(files: TransferPath[]): Promise<void>;
    get(remotePath: string, localPath: string): Promise<void>;
    mkdir(remotePath: string): Promise<void>;
    delete(remotePath: string): Promise<void>;
    close(): Promise<void>;
}

/**
 * SFTP client implementation using ssh2.
 */
class SftpClient implements RemoteClient {
    private config: SftpConfig;
    private client?: SshClient;
    private sftp?: SFTPWrapper;
    private readonly signal?: AbortSignal;

    /**
     * Creates a new SFTP client.
     * @param config - The SFTP configuration.
     */
    constructor(config: SftpConfig, signal?: AbortSignal) {
        this.config = config;
        this.signal = signal;
        signal?.addEventListener('abort', () => { void this.close(); }, { once: true });
    }

    /**
     * Tests the SFTP connection by listing the remote root.
     * @returns {Promise<void>}
     */
    async test(): Promise<void> {
        await this.connect();
        await this.list('.');
    }

    /**
     * Gets metadata for a remote file or directory.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath: string): Promise<RemoteItem | undefined> {
        const stats = await this.sftpStat(remotePath);
        if (!stats) {
            return undefined;
        }
        return {
            name: path.posix.basename(remotePath),
            size: stats.size,
            modifyTime: stats.mtime * 1000,
            isDirectory: stats.isDirectory(),
            isSymbolicLink: stats.isSymbolicLink(),
        };
    }

    /**
     * Lists the contents of a remote directory.
     * @param remoteDir - The remote directory path.
     * @returns {Promise<RemoteItem[]>} The directory entries.
     */
    async list(remoteDir: string): Promise<RemoteItem[]> {
        const sftp = await this.connect();
        return new Promise<RemoteItem[]>((resolve, reject) => {
            sftp.readdir(remoteDir, (err, list) => {
                if (err) {
                    if (isMissingError(err)) {
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
                    isSymbolicLink: e.attrs.isSymbolicLink(),
                })));
            });
        });
    }

    /**
     * Uploads a local file to the remote server.
     * @param localPath - The local file path.
     * @param remotePath - The remote destination path.
     * @returns {Promise<void>}
     */
    async put(localPath: string, remotePath: string): Promise<void> {
        const sftp = await this.connect();
        await this.ensureRemoteDir(path.posix.dirname(remotePath));
        return new Promise<void>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
        });
    }

    /**
     * Downloads a remote file to the local path.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath: string, localPath: string): Promise<void> {
        const sftp = await this.connect();
        ensureLocalDir(localPath);
        return new Promise<void>((resolve, reject) => {
            sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
        });
    }

    /**
     * Creates a directory on the remote server.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath: string): Promise<void> {
        const sftp = await this.connect();
        await this.ensureRemoteDir(remotePath);
    }

    /**
     * Deletes a remote file or directory.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath: string): Promise<void> {
        const sftp = await this.connect(),
            stats = await this.sftpStat(remotePath);
        if (!stats) {
            return;
        }
        return new Promise<void>((resolve, reject) => {
            const cb: Callback = (err) => (err ? reject(err) : resolve());
            stats.isDirectory() ? sftp.rmdir(remotePath, cb) : sftp.unlink(remotePath, cb);
        });
    }

    /**
     * Closes the underlying SSH connection.
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {
        if (this.client) {
            this.client.end();
            this.client = undefined;
            this.sftp = undefined;
        }
    }

    /**
     * Connects to the remote server and returns an SFTP wrapper.
     * @returns {Promise<SFTPWrapper>} The SFTP wrapper.
     */
    private async connect(): Promise<SFTPWrapper> {
        if (this.signal?.aborted) { throw new Error('Transfer cancelled'); }
        if (this.sftp) {
            return this.sftp;
        }
        this.client = new SshClient();
        const config = this.buildConfig();
        return new Promise<SFTPWrapper>((resolve, reject) => {
            this.client!.on('error', (err) => reject(err));
            this.client!.once('ready', () => {
                this.client!.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    // Keep the error listener installed for connection failures after readiness.
                    this.sftp = sftp;
                    resolve(sftp);
                });
            });
            this.client!.connect(config);
        });
    }

    /**
     * Builds the ssh2 connection configuration.
     * @returns {any} The ssh2 client options.
     */
    private buildConfig(): any {
        const cfg: any = {
            host: this.config.sftpHost,
            port: this.config.sftpPort ?? 22,
            username: this.config.sftpUser,
        };
        if (this.config.password) {
            cfg.password = this.config.password;
        }
        const key = resolvePrivateKey(this.config.privateKey ?? this.config.identity),
            agent = resolveKeyValue(this.config.agent);
        if (key) {
            cfg.privateKey = key;
        }
        if (this.config.passphrase) {
            cfg.passphrase = this.config.passphrase;
        }
        if (agent) {
            cfg.agent = agent;
        }
        return cfg;
    }

    /**
     * Gets ssh2 stats for a remote path.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<import('ssh2').Stats | undefined>} The stats, or undefined if missing.
     */
    private async sftpStat(remotePath: string): Promise<import('ssh2').Stats | undefined> {
        const sftp = await this.connect();
        return new Promise<import('ssh2').Stats | undefined>((resolve, reject) => {
            sftp.lstat(remotePath, (err, stats) => {
                if (err) {
                    if (isMissingError(err)) {
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

    /**
     * Creates the remote directory and its parents when needed.
     * @param dir - The remote directory path.
     * @returns {Promise<void>}
     */
    private async ensureRemoteDir(dir: string): Promise<void> {
        if (dir === '' || dir === '/' || dir === '.') {
            return;
        }
        const sftp = await this.connect(),
            exists = await this.dirExists(dir);
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

    /**
     * Checks whether a remote directory exists.
     * @param dir - The remote directory path.
     * @returns {Promise<boolean>} True when the directory exists.
     */
    private async dirExists(dir: string): Promise<boolean> {
        const sftp = await this.connect();
        return new Promise<boolean>((resolve, reject) => {
            sftp.stat(dir, (err, stats) => {
                if (err) {
                    if (isMissingError(err)) {
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

/**
 * FTP client implementation using basic-ftp.
 */
class FtpClient implements RemoteClient {
    private config: SftpConfig;
    private client: BasicFtpClient;
    private connected = false;
    private operations = new PQueue({ concurrency: 1 });
    private loginDirectory = "/";
    private readonly signal?: AbortSignal;

    /**
     * Creates a new FTP client.
     * @param config - The SFTP configuration.
     */
    constructor(config: SftpConfig, signal?: AbortSignal) {
        this.config = config;
        this.signal = signal;
        this.client = new BasicFtpClient();
        signal?.addEventListener('abort', () => {
            this.client.close();
            this.connected = false;
        }, { once: true });
    }

    /**
     * Tests the FTP connection by listing the remote root.
     * @returns {Promise<void>}
     */
    async test(): Promise<void> {
        return this.operations.add(async () => {
            await this.connect();
            await this.client.list();
        });
    }

    /**
     * Gets metadata for a remote file.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath: string): Promise<RemoteItem | undefined> {
        return this.operations.add(async () => {
            await this.connect();
            remotePath = path.posix.resolve(this.loginDirectory, remotePath);
            try {
                const size = await this.client.size(remotePath),
                    mtime = await this.client.lastMod(remotePath);
                return {
                    name: path.posix.basename(remotePath),
                    size,
                    modifyTime: mtime ? mtime.getTime() : 0,
                    isDirectory: false,
                };
            } catch (error: any) {
                if (error.code === 550) {
                    const entries = await this.client.list(path.posix.dirname(remotePath)),
                        entry = entries.find((item) => item.name === path.posix.basename(remotePath));
                    return entry ? this.mapFileInfo(entry) : undefined;
                }
                throw error;
            }
        });
    }

    /**
     * Lists the contents of a remote directory.
     * @param remoteDir - The remote directory path.
     * @returns {Promise<RemoteItem[]>} The directory entries.
     */
    async list(remoteDir: string): Promise<RemoteItem[]> {
        return this.operations.add(async () => {
            await this.connect();
            const list = await this.client.list(path.posix.resolve(this.loginDirectory, remoteDir || '.'));
            return list.map(this.mapFileInfo);
        });
    }

    /**
     * Uploads a local file to the FTP server.
     * @param localPath - The local file path.
     * @param remotePath - The remote destination path.
     * @returns {Promise<void>}
     */
    async put(localPath: string, remotePath: string): Promise<void> {
        return this.operations.add(async () => {
            await this.connect();
            remotePath = path.posix.resolve(this.loginDirectory, remotePath);
            const parent = path.posix.dirname(remotePath),
                base = path.posix.basename(remotePath);
            await this.client.ensureDir(parent);
            await this.client.uploadFrom(localPath, base);
        });
    }

    /**
     * Downloads a remote file to the local path.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath: string, localPath: string): Promise<void> {
        return this.operations.add(async () => {
            await this.connect();
            ensureLocalDir(localPath);
            await this.client.downloadTo(localPath, path.posix.resolve(this.loginDirectory, remotePath));
        });
    }

    /**
     * Creates a directory on the FTP server.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath: string): Promise<void> {
        return this.operations.add(async () => {
            await this.connect();
            await this.client.ensureDir(path.posix.resolve(this.loginDirectory, remotePath));
        });
    }

    /**
     * Deletes a remote file or directory.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath: string): Promise<void> {
        return this.operations.add(async () => {
            await this.connect();
            remotePath = path.posix.resolve(this.loginDirectory, remotePath);
            const parent = path.posix.dirname(remotePath),
                base = path.posix.basename(remotePath);
            await this.client.ensureDir(parent);
            await this.client.remove(base, true);
        });
    }

    /**
     * Closes the FTP connection.
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {
        await this.operations.onIdle();
        this.client.close();
        this.connected = false;
    }

    /**
     * Connects to the FTP server.
     * @returns {Promise<void>}
     */
    private async connect(): Promise<void> {
        if (this.signal?.aborted) { throw new Error('Transfer cancelled'); }
        if (this.connected) {
            return;
        }
        if (this.config.ftpPassive) {
            this.client.prepareTransfer = enterPassiveModeIPv4;
        }
        await this.client.access({
            host: this.config.ftpHost,
            port: this.config.ftpPort ?? 21,
            user: this.config.ftpUser,
            password: this.config.password,
            secure: this.config.ftpSecure ?? false,
        });
        this.loginDirectory = await this.client.pwd();
        this.connected = true;
    }

    /**
     * Converts a basic-ftp file info object into a RemoteItem.
     * @param info - The basic-ftp file info.
     * @returns {RemoteItem} The mapped remote item.
     */
    private mapFileInfo(info: BasicFtpFileInfo): RemoteItem {
        return {
            name: info.name,
            size: info.size,
            modifyTime: info.modifiedAt ? info.modifiedAt.getTime() : 0,
            isDirectory: info.isDirectory,
            isSymbolicLink: info.isSymbolicLink,
        };
    }
}

/** Each lease owns one serialized FTP connection; no concurrent commands share a socket. */
class FtpPool implements RemoteClient {
    private readonly clients: FtpClient[] = [];
    private readonly available: FtpClient[] = [];
    private readonly queue: PQueue;

    constructor(private readonly config: SftpConfig, private readonly signal?: AbortSignal) {
        this.queue = new PQueue({ concurrency: Math.max(transferConcurrency(config.concurrency), transferConcurrency(config.scanConcurrency)) });
    }

    private async use<T>(action: (client: FtpClient) => Promise<T>): Promise<T> {
        return this.queue.add(async () => {
            let client = this.available.pop();
            if (!client) { client = new FtpClient(this.config, this.signal); this.clients.push(client); }
            try { return await action(client); }
            finally { this.available.push(client); }
        });
    }

    test() { return this.use((client) => client.test()); }
    list(directory: string) { return this.use((client) => client.list(directory)); }
    stat(file: string) { return this.use((client) => client.stat(file)); }
    put(local: string, remote: string) { return this.use((client) => client.put(local, remote)); }
    get(remote: string, local: string) { return this.use((client) => client.get(remote, local)); }
    mkdir(directory: string) { return this.use((client) => client.mkdir(directory)); }
    delete(file: string) { return this.use((client) => client.delete(file)); }
    async close(): Promise<void> {
        await this.queue.onIdle();
        await Promise.all(this.clients.map((client) => client.close()));
    }
}


/**
 * Escapes a shell argument by wrapping it in single quotes.
 * @param arg - The argument to escape.
 * @returns {string} The escaped argument.
 */
function escapeShell(arg: string): string {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs a tsh ssh command with the configured Teleport options.
 * @param config - The SFTP configuration.
 * @param command - The command to execute on the remote host.
 * @returns {Promise<string>} The command output.
 */
async function runTshCommand(config: SftpConfig, command: string, rawOutput = false, signal?: AbortSignal): Promise<string> {
    const tshPath = await ensureTsh();
    const args: string[] = ['ssh'];
    if (config.teleportCluster) {
        args.push('--cluster', config.teleportCluster);
    }
    args.push(`${config.sftpUser}@${config.sftpHost}`, command);
    return spawnCommand(tshPath, args, { env: process.env, rawOutput, signal });
}

/**
 * Teleport client implementation using tsh and rsync.
 */
class TeleportClient implements RemoteClient {
    private config: SftpConfig;

    /**
     * Creates a new Teleport client.
     * @param config - The SFTP configuration.
     */
    constructor(config: SftpConfig, private readonly signal?: AbortSignal) {
        this.config = config;
    }

    /**
     * Tests the Teleport connection by running a remote echo.
     * @returns {Promise<void>}
     */
    async test(): Promise<void> {
        await runTshCommand(this.config, 'echo ok', false, this.signal);
    }

    /**
     * Gets metadata for a remote file using tsh stat.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath: string): Promise<RemoteItem | undefined> {
        const p = escapeShell(remotePath);
        try {
            const output = await runTshCommand(this.config, `LC_ALL=C stat -c '%s %Y %F' -- ${p}`, false, this.signal),
                parts = output.trim().split(' '),
                size = parseInt(parts[0], 10) || 0,
                mtime = parseInt(parts[1], 10) || 0,
                type = parts.slice(2).join(' ');
            return {
                name: path.posix.basename(remotePath),
                size,
                modifyTime: mtime * 1000,
                isDirectory: type.includes('directory'),
                isSymbolicLink: type.includes('symbolic link'),
            };
        } catch (error: any) {
            if (/cannot stat.*No such file or directory/s.test(error.message)) { return undefined; }
            throw error;
        }
    }

    async statMany(remotePaths: string[]): Promise<Map<string, RemoteItem | undefined>> {
        if (remotePaths.length === 0) { return new Map(); }
        const pathArguments = remotePaths.map(escapeShell).join(' '),
            command = `for p in ${pathArguments}; do if [ -L "$p" ]; then printf '0 0 symbolic-link\\n'; `
                + `elif [ -d "$p" ]; then LC_ALL=C stat -c '%s %Y directory' -- "$p"; `
                + `elif [ -f "$p" ]; then LC_ALL=C stat -c '%s %Y regular-file' -- "$p"; `
                + `else printf '0 0 missing\\n'; fi; done`,
            output = await runTshCommand(this.config, command, false, this.signal),
            lines = output.split('\n');
        if (lines.length !== remotePaths.length) { throw new Error('Incomplete Teleport metadata response'); }
        return new Map(remotePaths.map((remotePath, index) => {
            const [size, mtime, type] = lines[index].split(' ');
            if (type === 'missing') { return [remotePath, undefined]; }
            return [remotePath, {
                name: path.posix.basename(remotePath),
                size: parseInt(size, 10) || 0,
                modifyTime: (parseInt(mtime, 10) || 0) * 1000,
                isDirectory: type === 'directory',
                isSymbolicLink: type === 'symbolic-link'
            }];
        }));
    }

    /**
     * Lists the contents of a remote directory using tsh find.
     * @param remoteDir - The remote directory path.
     * @returns {Promise<RemoteItem[]>} The directory entries.
     */
    async list(remoteDir: string): Promise<RemoteItem[]> {
        const dir = escapeShell(normalizeRemotePath(remoteDir)),
            output = await runTshCommand(this.config, `find ${dir} -maxdepth 1 -mindepth 1 -printf '%f\\0%s\\0%T@\\0%y\\0'`, true, this.signal),
            items: RemoteItem[] = [];
        const fields = output.split('\0');
        for (let index = 0; index + 3 < fields.length; index += 4) {
            const [name, size, mtime, type] = fields.slice(index, index + 4);
            if (!name) {
                continue;
            }
            items.push({
                name,
                size: parseInt(size, 10) || 0,
                modifyTime: Math.floor(parseFloat(mtime) * 1000) || 0,
                isDirectory: type === 'd',
                isSymbolicLink: type !== 'd' && type !== 'f',
            });
        }
        return items;
    }

    /**
     * Uploads a local file to the remote host via rsync over tsh.
     * @param localPath - The local file path.
     * @param remotePath - The remote destination path.
     * @returns {Promise<void>}
     */
    async put(localPath: string, remotePath: string): Promise<void> {
        await this.putMany([{ localPath, remotePath }]);
    }

    async putMany(files: TransferPath[]): Promise<void> {
        if (files.length === 0) { return; }
        const args = await this.getRsyncArgs(),
            localRoot = path.resolve(this.config.localPath!),
            remoteRoot = normalizeRemotePath(this.config.remotePath!),
            sources = files.map(({ localPath, remotePath }) => {
                const relativeLocal = path.relative(localRoot, localPath).replace(/\\/g, '/'),
                    relativeRemote = path.posix.relative(remoteRoot, remotePath);
                if (!relativeLocal || relativeLocal.startsWith('../') || path.isAbsolute(relativeLocal)
                    || relativeRemote !== relativeLocal) {
                    throw new Error(`Unsafe Teleport upload path: ${relativeLocal || localPath}`);
                }
                return relativeLocal.split('/').join(path.sep);
            }),
            destinationRoot = remoteRoot === '/' ? '/' : `${remoteRoot}/`,
            remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${escapeShell(destinationRoot)}`;
        await spawnCommand('rsync', [...args, '--relative', '--', ...sources, remoteSpec], {
            env: process.env,
            cwd: localRoot,
            signal: this.signal
        });
    }

    /**
     * Downloads a remote file via rsync over tsh.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath: string, localPath: string): Promise<void> {
        ensureLocalDir(localPath);
        const args = await this.getRsyncArgs(),
            remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${escapeShell(remotePath)}`;
        await spawnCommand('rsync', [...args, '--', remoteSpec, localPath], { env: process.env, signal: this.signal });
    }

    /**
     * Creates a directory on the remote host using tsh.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath: string): Promise<void> {
        const dir = escapeShell(normalizeRemotePath(remotePath));
        await runTshCommand(this.config, `mkdir -p ${dir}`, false, this.signal);
    }

    /**
     * Deletes a remote file using tsh.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath: string): Promise<void> {
        const p = escapeShell(remotePath);
        await runTshCommand(this.config, `rm -f ${p}`, false, this.signal);
    }

    /**
     * Closes the client; Teleport is stateless.
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {
        // stateless
    }

    /**
     * Builds the base rsync arguments for Teleport transfers.
     * @returns {Promise<string[]>} The rsync argument list.
     */
    private async getRsyncArgs(): Promise<string[]> {
        const tshPath = await ensureTsh(),
            shell = `${escapeShell(tshPath)} ssh${this.config.teleportCluster ? ` --cluster=${escapeShell(this.config.teleportCluster)}` : ''}`,
            extras = normalizeRsyncOptions(this.config).rsyncFlags?.split(/\s+/).filter(Boolean) ?? [];
        return ['-rtz', '--ignore-times', '-e', shell, ...extras];
    }

}

/**
 * Creates a RemoteClient for the configured connection mode.
 * @param config - The SFTP configuration.
 * @returns {RemoteClient} The created client.
 */
function createRemoteClient(config: SftpConfig, signal?: AbortSignal): RemoteClient {
    const mode = resolveMode(config);
    if (mode === 'ftp') {
        return new FtpPool(config, signal);
    }
    if (mode === 'teleport') {
        return new TeleportClient(config, signal);
    }
    return new SftpClient(config, signal);
}

/**
 * Runs an action with a connected RemoteClient and ensures cleanup.
 * @param config - The SFTP configuration.
 * @param action - A function that receives the client and returns a value.
 * @returns {Promise<T>} The action result.
 */
async function withRemoteClient<T>(config: SftpConfig, action: (client: RemoteClient) => Promise<T>): Promise<T> {
    config = normalizeRsyncOptions(config);
    return remoteActionQueue.add(async () => {
        const controller = new AbortController();
        activeTransferController = controller;
        let client: RemoteClient | undefined;
        let rejectCancellation: ((reason: Error) => void) | undefined;
        const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; }),
            onAbort = () => rejectCancellation?.(new Error('Transfer cancelled'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if (resolveMode(config) === 'teleport') { await ensureTeleportSession(config); }
            client = createRemoteClient(config, controller.signal);
            return await Promise.race([action(client), cancellation]);
        } finally {
            controller.signal.removeEventListener('abort', onAbort);
            await client?.close();
            if (activeTransferController === controller) { activeTransferController = undefined; }
        }
    });
}

/**
 * Validates the configuration and runs an action with a RemoteClient.
 * @param config - The SFTP configuration.
 * @param action - A function that receives the client and returns a value.
 * @returns {Promise<T>} The action result.
 */
async function runRemoteAction<T>(config: SftpConfig, action: (client: RemoteClient) => Promise<T>): Promise<T> {
    validateConfig(config);
    return withRemoteClient(config, action);
}

/**
 * Runs a sync for the configured mode.
 * @param config - The SFTP configuration.
 * @param options - Optional sync options.
 * @returns {Promise<string>} The sync output summary.
 */
export async function runSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    return withRemoteClient(config, (client) => new SyncEngine(config).sync(client, options));
}

/** Publish locally changed files without a two-way scan. */
export async function uploadChangedFiles(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    return withRemoteClient(config, (client) => new SyncEngine(config).uploadChanged(client, options));
}

/**
 * Computes the remote path for a given local file.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {string} The remote destination path.
 */
function getRemotePath(config: SftpConfig, localPath: string): string {
    const root = config.localPath!,
        rel = path.relative(root, localPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || rel === '') {
        throw new Error('File is outside the configured local path');
    }
    return path.posix.join(normalizeRemotePath(config.remotePath!), rel);
}

/**
 * Uploads a local file to the remote server.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
export async function uploadFile(config: SftpConfig, localPath: string): Promise<void> {
    getRemotePath(config, localPath);
    await runRemoteAction(config, (client) => new SyncEngine(config).transferFile(client,
        path.relative(config.localPath!, localPath).replace(/\\/g, '/'), 'upload'));
}

/**
 * Downloads a remote file to the local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
export async function downloadFile(config: SftpConfig, localPath: string): Promise<void> {
    getRemotePath(config, localPath);
    await runRemoteAction(config, (client) => new SyncEngine(config).transferFile(client,
        path.relative(config.localPath!, localPath).replace(/\\/g, '/'), 'download'));
}

/**
 * Deletes a remote file corresponding to the local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
export async function deleteRemoteFile(config: SftpConfig, localPath: string): Promise<void> {
    await runRemoteAction(config, (client) => client.delete(getRemotePath(config, localPath)));
}

/**
 * Syncs a single file with the remote server.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<string>} The sync result message.
 */
export async function syncFile(config: SftpConfig, localPath: string): Promise<string> {
    getRemotePath(config, localPath);
    return runSync(config, { files: [path.relative(config.localPath!, localPath).replace(/\\/g, '/')] });
}


/**
 * Runs tsh status to verify the Teleport session.
 * @param _config - The SFTP configuration (unused).
 * @returns {Promise<string>} The tsh status output.
 */
export async function testTeleport(_config: SftpConfig): Promise<string> {
    const tshPath = await ensureTsh();
    return spawnCommand(tshPath, ['status'], { env: process.env });
}

/**
 * Tests the configured connection for the current mode.
 * @param config - The SFTP configuration.
 * @returns {Promise<string>} The test result.
 */
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
    return withRemoteClient(config, async (client) => {
        await client.test();
        return 'Connection successful';
    });
}

/**
 * Logs in to Teleport and returns the command output.
 * @param config - The SFTP configuration.
 * @param options - Optional login options.
 * @returns {Promise<string>} The login output.
 */
export async function loginToTeleport(config: SftpConfig, options: LoginOptions = {}): Promise<string> {
    const tshPath = await ensureTsh();
    const args: string[] = ['login', '--browser=none'];
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
        const child = cp.spawn(tshPath, args, { env: process.env });
        let stdout = '', stderr = '', linkSent = false;

        const handleData = (data: Buffer): string => {
            const text = data.toString();
            if (options.onLink) {
                const proxyHost = config.teleportHost
                    ? config.teleportHost.replace(/^https?:\/\//, '').split('/')[0]
                    : undefined;
                const matches = text.match(/https?:\/\/[^\s]+/g);
                const url = matches?.find((u) => !proxyHost || u.includes(proxyHost.split(':')[0]))
                    || matches?.[0];
                if (url && !linkSent) {
                    linkSent = true;
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

/**
 * Ensures an active Teleport session, logging in if necessary.
 * @param config - The SFTP configuration.
 * @param options - Optional login options.
 * @returns {Promise<string>} The session status output.
 */
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

/**
 * Validates that all required settings for the current mode are present.
 * @param config - The SFTP configuration.
 * @returns {void}
 */
export function validateConfig(config: SftpConfig): void {
    const mode = resolveMode(config),
        missing: string[] = [];
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

/**
 * Spawns a child process and returns its stdout.
 * @param command - The executable to run.
 * @param args - The command arguments.
 * @param options - The spawn options.
 * @returns {Promise<string>} The command stdout.
 */
function spawnCommand(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; rawOutput?: boolean; onOutput?: (text: string) => void; signal?: AbortSignal }
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn(command, args, { env: options.env, cwd: options.cwd, signal: options.signal });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; options.onOutput?.(text); });
        child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; options.onOutput?.(text); });
        child.on('error', (error: any) => {
            if (error?.name === 'AbortError') {
                reject(new Error('Transfer cancelled'));
                return;
            }
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
            resolve(options.rawOutput ? stdout : stdout.trim());
        });
    });
}
