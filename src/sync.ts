import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Client as BasicFtpClient, enterPassiveModeIPv4, FileInfo as BasicFtpFileInfo } from 'basic-ftp';
import ignore from 'ignore';
import PQueue from 'p-queue';
import { Callback, Client as SshClient, SFTPWrapper } from 'ssh2';
import { resolveMode, SftpConfig } from './config';
import { ensureLocalDir, normalizeRemotePath, resolveKeyValue, resolvePrivateKey } from './utils';

const SESSION_CACHE_MS = 60000;

let cachedSession: { configKey: string; output: string; validUntil: number } | undefined;

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
    dryRun?: boolean;
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

export interface RemoteClient {
    test(): Promise<void>;
    list(remoteDir: string): Promise<RemoteItem[]>;
    stat(remotePath: string): Promise<RemoteItem | undefined>;
    put(localPath: string, remotePath: string): Promise<void>;
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

    /**
     * Creates a new SFTP client.
     * @param config - The SFTP configuration.
     */
    constructor(config: SftpConfig) {
        this.config = config;
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
            sftp.stat(remotePath, (err, stats) => {
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

    /**
     * Creates a new FTP client.
     * @param config - The SFTP configuration.
     */
    constructor(config: SftpConfig) {
        this.config = config;
        this.client = new BasicFtpClient();
    }

    /**
     * Tests the FTP connection by listing the remote root.
     * @returns {Promise<void>}
     */
    async test(): Promise<void> {
        await this.connect();
        await this.client.list();
    }

    /**
     * Gets metadata for a remote file.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath: string): Promise<RemoteItem | undefined> {
        await this.connect();
        try {
            const [size, mtime] = await Promise.all([
                this.client.size(remotePath),
                this.client.lastMod(remotePath),
            ]);
            return {
                name: path.posix.basename(remotePath),
                size,
                modifyTime: mtime ? mtime.getTime() : 0,
                isDirectory: false,
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Lists the contents of a remote directory.
     * @param remoteDir - The remote directory path.
     * @returns {Promise<RemoteItem[]>} The directory entries.
     */
    async list(remoteDir: string): Promise<RemoteItem[]> {
        await this.connect();
        const list = remoteDir === '.' || !remoteDir
            ? await this.client.list()
            : await this.client.list(remoteDir);
        return list.map(this.mapFileInfo);
    }

    /**
     * Uploads a local file to the FTP server.
     * @param localPath - The local file path.
     * @param remotePath - The remote destination path.
     * @returns {Promise<void>}
     */
    async put(localPath: string, remotePath: string): Promise<void> {
        await this.connect();
        const parent = path.posix.dirname(remotePath),
            base = path.posix.basename(remotePath);
        await this.client.ensureDir(parent);
        await this.client.uploadFrom(localPath, base);
    }

    /**
     * Downloads a remote file to the local path.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath: string, localPath: string): Promise<void> {
        await this.connect();
        ensureLocalDir(localPath);
        const parent = path.posix.dirname(remotePath),
            base = path.posix.basename(remotePath);
        await this.client.ensureDir(parent);
        await this.client.downloadTo(localPath, base);
    }

    /**
     * Creates a directory on the FTP server.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath: string): Promise<void> {
        await this.connect();
        await this.client.ensureDir(remotePath);
    }

    /**
     * Deletes a remote file or directory.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath: string): Promise<void> {
        await this.connect();
        const parent = path.posix.dirname(remotePath),
            base = path.posix.basename(remotePath);
        await this.client.ensureDir(parent);
        await this.client.remove(base, true);
    }

    /**
     * Closes the FTP connection.
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {
        this.client.close();
        this.connected = false;
    }

    /**
     * Connects to the FTP server.
     * @returns {Promise<void>}
     */
    private async connect(): Promise<void> {
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
        };
    }
}

/**
 * Formats a byte count as a human-readable string.
 * @param bytes - The number of bytes.
 * @returns {string} The formatted size.
 */
function formatBytes(bytes: number): string {
    if (!bytes) { return '0.00 B'; }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'],
        pwr = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 5);
    return `${(bytes / Math.pow(1024, pwr)).toFixed(2)} ${units[pwr]}`;
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
async function runTshCommand(config: SftpConfig, command: string): Promise<string> {
    const args: string[] = ['ssh'];
    if (config.teleportCluster) {
        args.push('--cluster', config.teleportCluster);
    }
    args.push(`${config.sftpUser}@${config.sftpHost}`, command);
    return spawnCommand('tsh', args, { env: process.env });
}

/**
 * Builds rsync --exclude arguments from the ignore list and defaults.
 * @param config - The SFTP configuration.
 * @returns {string[]} The exclude argument pairs.
 */
function getRsyncExcludeArgs(config: SftpConfig): string[] {
    const patterns = (config.ignore ?? []).slice(),
        defaults = ['.git', '.vscode', '.windsurfrules', 'node_modules', '.DS_Store', '*.log', '.env', 'vendor', 'debugbar', 'cache'];
    for (const p of defaults) {
        if (!patterns.includes(p)) {
            patterns.push(p);
        }
    }
    const args: string[] = [];
    for (const p of patterns) {
        if (p) {
            args.push('--exclude', p);
        }
    }
    return args;
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
    constructor(config: SftpConfig) {
        this.config = config;
    }

    /**
     * Tests the Teleport connection by running a remote echo.
     * @returns {Promise<void>}
     */
    async test(): Promise<void> {
        await runTshCommand(this.config, 'echo ok');
    }

    /**
     * Gets metadata for a remote file using tsh stat.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath: string): Promise<RemoteItem | undefined> {
        const p = escapeShell(remotePath);
        try {
            const output = await runTshCommand(this.config, `stat -c '%s %Y %F' ${p}`),
                parts = output.trim().split(' '),
                size = parseInt(parts[0], 10) || 0,
                mtime = parseInt(parts[1], 10) || 0,
                type = parts.slice(2).join(' ');
            return {
                name: path.posix.basename(remotePath),
                size,
                modifyTime: mtime * 1000,
                isDirectory: type.includes('directory'),
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Lists the contents of a remote directory using tsh find.
     * @param remoteDir - The remote directory path.
     * @returns {Promise<RemoteItem[]>} The directory entries.
     */
    async list(remoteDir: string): Promise<RemoteItem[]> {
        const dir = escapeShell(normalizeRemotePath(remoteDir)),
            output = await runTshCommand(this.config, `find ${dir} -maxdepth 1 -mindepth 1 -printf '%f\\t%s\\t%T@\\t%y\\n'`),
            items: RemoteItem[] = [];
        for (const line of output.split('\n')) {
            const [name, size, mtime, type] = line.split('\t');
            if (!name) {
                continue;
            }
            items.push({
                name,
                size: parseInt(size, 10) || 0,
                modifyTime: Math.floor(parseFloat(mtime) * 1000) || 0,
                isDirectory: type === 'd',
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
        const parent = escapeShell(path.posix.dirname(remotePath));
        await runTshCommand(this.config, `mkdir -p ${parent}`);
        const args = this.getRsyncArgs(),
            remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${remotePath}`;
        await spawnCommand('rsync', [...args, localPath, remoteSpec], { env: process.env });
    }

    /**
     * Downloads a remote file via rsync over tsh.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath: string, localPath: string): Promise<void> {
        ensureLocalDir(localPath);
        const args = this.getRsyncArgs(),
            remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${remotePath}`;
        await spawnCommand('rsync', [...args, remoteSpec, localPath], { env: process.env });
    }

    /**
     * Creates a directory on the remote host using tsh.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath: string): Promise<void> {
        const dir = escapeShell(normalizeRemotePath(remotePath));
        await runTshCommand(this.config, `mkdir -p ${dir}`);
    }

    /**
     * Deletes a remote file using tsh.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath: string): Promise<void> {
        const p = escapeShell(remotePath);
        await runTshCommand(this.config, `rm -f ${p}`);
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
     * @returns {string[]} The rsync argument list.
     */
    private getRsyncArgs(): string[] {
        const args: string[] = ['-avz'];
        const shell = this.config.teleportCluster ? `tsh ssh --cluster=${this.config.teleportCluster}` : 'tsh ssh';
        args.push('-e', shell);
        for (const p of (this.config.ignore ?? [])) {
            if (p) {
                args.push('--exclude', p);
            }
        }
        const extras = this.config.rsyncFlags?.split(' ').filter((f) => f) ?? [];
        args.push(...extras);
        return args;
    }
}

/**
 * Creates a RemoteClient for the configured connection mode.
 * @param config - The SFTP configuration.
 * @returns {RemoteClient} The created client.
 */
function createRemoteClient(config: SftpConfig): RemoteClient {
    const mode = resolveMode(config);
    if (mode === 'ftp') {
        return new FtpClient(config);
    }
    if (mode === 'teleport') {
        return new TeleportClient(config);
    }
    return new SftpClient(config);
}

/**
 * Runs an action with a connected RemoteClient and ensures cleanup.
 * @param config - The SFTP configuration.
 * @param action - A function that receives the client and returns a value.
 * @returns {Promise<T>} The action result.
 */
async function withRemoteClient<T>(config: SftpConfig, action: (client: RemoteClient) => Promise<T>): Promise<T> {
    if (resolveMode(config) === 'teleport') {
        await ensureTeleportSession(config);
    }
    const client = createRemoteClient(config);
    try {
        return await action(client);
    } finally {
        await client.close();
    }
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
 * Runs an rsync-based sync for Teleport mode.
 * @param config - The SFTP configuration.
 * @param options - Optional sync options.
 * @returns {Promise<string>} The sync output summary.
 */
async function teleportSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    const localRoot = normalizeRemotePath(config.localPath!),
        remoteRoot = normalizeRemotePath(config.remotePath!),
        source = localRoot.endsWith('/') ? localRoot : `${localRoot}/`,
        remoteDir = remoteRoot.endsWith('/') ? remoteRoot : `${remoteRoot}/`,
        dest = `${config.sftpUser}@${config.sftpHost}:${remoteDir}`,
        excludes = getRsyncExcludeArgs(config),
        extras = config.rsyncFlags?.split(' ').filter((f) => f) ?? [],
        shell = config.teleportCluster ? `tsh ssh --cluster=${config.teleportCluster}` : 'tsh ssh';

    if (options.dryRun) {
        const args = ['-avz', '--delete', '--dry-run', '--itemize-changes', '-e', shell, ...excludes, ...extras, source, dest],
            output = await spawnCommand('rsync', args, { env: process.env });
        return `DRY RUN\n${output}`;
    }

    const args = ['-avz', '--delete', '--stats', '-e', shell, ...excludes, ...extras, source, dest],
        output = await spawnCommand('rsync', args, { env: process.env }),
        filesMatch = output.match(/Number of files transferred:\s*([\d,]+)/),
        bytesMatch = output.match(/Total transferred file size:\s*([\d,]+)/),
        files = filesMatch ? parseInt(filesMatch[1].replace(/,/g, ''), 10) : 0,
        bytes = bytesMatch ? parseInt(bytesMatch[1].replace(/,/g, ''), 10) : 0;
    return `SYNC COMPLETE\nFiles transferred: ${files}\nSize: ${formatBytes(bytes)}`;
}

/**
 * Sync engine that plans and executes directory synchronization.
 */
export class SyncEngine {
    private config: SftpConfig;

    /**
     * Creates a new sync engine.
     * @param config - The SFTP configuration.
     */
    constructor(config: SftpConfig) {
        this.config = config;
    }

    /**
     * Plans and executes a synchronization between local and remote directories.
     * @param client - The remote client.
     * @param options - Optional sync options.
     * @returns {Promise<string>} The sync output summary.
     */
    async sync(client: RemoteClient, options: SyncOptions = {}): Promise<string> {
        const localRoot = this.config.localPath!,
            remoteRoot = normalizeRemotePath(this.config.remotePath!),
            concurrency = this.config.concurrency ?? 4,
            ig = ignore().add(this.config.ignore ?? []),
            queue = new PQueue({ concurrency });

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

        await this.execute(client, plan, queue, localRoot, remoteRoot, options.onProgress);
        await queue.onIdle();

        return `SYNC COMPLETE\n${report}`;
    }

    /**
     * Recursively collects local files and directories.
     * @param localRoot - The local root path.
     * @param ig - The ignore filter.
     * @returns {Promise<Map<string, FileItem>>} The collected local files.
     */
    private async collectLocalFiles(localRoot: string, ig: any): Promise<Map<string, FileItem>> {
        const files = new Map<string, FileItem>();

        const walk = async (dir: string, dirRel: string) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
                if (ig.ignores(rel)) {
                    continue;
                }
                const full = path.join(dir, e.name),
                    stat = await fs.promises.stat(full),
                    item: FileItem = {
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

    /**
     * Recursively collects remote files and directories.
     * @param client - The remote client.
     * @param remoteRoot - The remote root path.
     * @param queue - The promise queue for concurrency.
     * @param ig - The ignore filter.
     * @returns {Promise<Map<string, FileItem>>} The collected remote files.
     */
    private async collectRemoteFiles(
        client: RemoteClient,
        remoteRoot: string,
        queue: PQueue,
        ig: any
    ): Promise<Map<string, FileItem>> {
        const files = new Map<string, FileItem>(),
            errors: Error[] = [];

        const visit = async (dirRel: string) => {
            const full = dirRel ? path.posix.join(remoteRoot, dirRel) : remoteRoot,
                entries = await client.list(full);
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

    /**
     * Builds a sync plan comparing local and remote file sets.
     * @param localFiles - The local file map.
     * @param remoteFiles - The remote file map.
     * @returns {SyncPlan} The directories, uploads, and removals to perform.
     */
    private buildPlan(localFiles: Map<string, FileItem>, remoteFiles: Map<string, FileItem>): SyncPlan {
        const makeDirs: string[] = [],
            upload: string[] = [],
            remove: string[] = [];

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
            const localSeconds = Math.floor(item.modifyTime / 1000),
                remoteSeconds = Math.floor(remote.modifyTime / 1000);
            if (remoteSeconds > 0 && localSeconds > remoteSeconds) {
                upload.push(rel);
            }
        }

        for (const rel of remoteFiles.keys()) {
            if (!localFiles.has(rel)) {
                remove.push(rel);
            }
        }

        return { makeDirs, upload, remove };
    }

    /**
     * Executes the sync plan against the remote server.
     * @param client - The remote client.
     * @param plan - The sync plan.
     * @param queue - The promise queue for concurrency.
     * @param localRoot - The local root path.
     * @param remoteRoot - The remote root path.
     * @param onProgress - Optional progress callback.
     * @returns {Promise<void>}
     */
    private async execute(
        client: RemoteClient,
        plan: SyncPlan,
        queue: PQueue,
        localRoot: string,
        remoteRoot: string,
        onProgress?: (current: number, total: number, file: string, action: string) => void
    ): Promise<void> {
        let current = 0;
        const total = plan.makeDirs.length + plan.upload.length + plan.remove.length,
            notify = (file: string, action: string) => { if (onProgress) { current += 1; onProgress(current, total, file, action); } },
            jobs: Promise<void>[] = [];

        for (const d of plan.makeDirs) {
            const remotePath = path.posix.join(remoteRoot, d);
            jobs.push(queue.add(() => client.mkdir(remotePath).then(() => notify(d, 'mkdir'))));
        }
        for (const rel of plan.upload) {
            const localPath = path.join(localRoot, rel),
                remotePath = path.posix.join(remoteRoot, rel);
            jobs.push(queue.add(() => client.put(localPath, remotePath).then(() => notify(rel, 'upload'))));
        }
        for (const rel of plan.remove) {
            const remotePath = path.posix.join(remoteRoot, rel);
            jobs.push(queue.add(() => client.delete(remotePath).then(() => notify(rel, 'delete'))));
        }

        await Promise.all(jobs);
    }

    /**
     * Formats the sync plan as a human-readable report.
     * @param plan - The sync plan.
     * @returns {string} The formatted report.
     */
    private formatReport(plan: SyncPlan): string {
        return [
            `Upload: ${plan.upload.length}`,
            `Delete: ${plan.remove.length}`,
            `Create dirs: ${plan.makeDirs.length}`,
        ].join('\n');
    }
}

/**
 * Runs a sync for the configured mode.
 * @param config - The SFTP configuration.
 * @param options - Optional sync options.
 * @returns {Promise<string>} The sync output summary.
 */
export async function runSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    if (resolveMode(config) === 'teleport') {
        await ensureTeleportSession(config);
        return teleportSync(config, options);
    }
    return withRemoteClient(config, (client) => new SyncEngine(config).sync(client, options));
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
    await runRemoteAction(config, (client) => client.put(localPath, getRemotePath(config, localPath)));
}

/**
 * Downloads a remote file to the local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
export async function downloadFile(config: SftpConfig, localPath: string): Promise<void> {
    await runRemoteAction(config, (client) => {
        const remotePath = getRemotePath(config, localPath);
        ensureLocalDir(localPath);
        return client.get(remotePath, localPath);
    });
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
    return runRemoteAction(config, async (client) => {
        const remotePath = getRemotePath(config, localPath);
        const localStat = fs.statSync(localPath);
        const remoteItem = await client.stat(remotePath);
        if (!remoteItem) {
            await client.put(localPath, remotePath);
            return 'Uploaded (remote missing)';
        }
        if (remoteItem.isDirectory) {
            throw new Error('Cannot sync a directory');
        }
        const localSeconds = Math.floor(localStat.mtimeMs / 1000);
        const remoteSeconds = Math.floor(remoteItem.modifyTime / 1000);
        if (localStat.size !== remoteItem.size || localSeconds !== remoteSeconds) {
            if (localSeconds >= remoteSeconds) {
                await client.put(localPath, remotePath);
                return 'Uploaded (newer or changed)';
            }
            ensureLocalDir(localPath);
            await client.get(remotePath, localPath);
            fs.utimesSync(localPath, new Date(), new Date(remoteItem.modifyTime));
            return 'Downloaded (newer)';
        }
        return 'In sync';
    });
}

/**
 * Runs tsh status to verify the Teleport session.
 * @param _config - The SFTP configuration (unused).
 * @returns {Promise<string>} The tsh status output.
 */
export function testTeleport(_config: SftpConfig): Promise<string> {
    return spawnCommand('tsh', ['status'], { env: process.env });
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
