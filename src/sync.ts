import * as fs from 'fs';
import * as path from 'path';
import { Client as BasicFtpClient, enterPassiveModeIPv4, FileInfo as BasicFtpFileInfo } from 'basic-ftp';
import ignore from 'ignore';
import PQueue from 'p-queue';
import { Callback, Client as SshClient, SFTPWrapper } from 'ssh2';
import { resolveMode, SftpConfig } from './config';
import { ensureLocalDir, getIgnorePatterns, normalizeRemotePath, resolveKeyValue, resolvePrivateKey } from './utils';
import { TeleportClient } from './teleport-client';
import * as tsh from './tsh';

export { RemoteClient, RemoteItem } from './remote-client';

/**
 * Checks whether the given error represents a missing file.
 * @param err - The error to inspect.
 * @returns {boolean} True when the error indicates no such file.
 */
function isMissingError(err: any): boolean {
    const code = err.code;
    if (code === 2) { return true; }
    return /NO_SUCH_FILE|No such file/i.test(err.message);
}

export interface SyncOptions {
    dryRun?: boolean;
    cwd?: string;
    onProgress?: (current: number, total: number, file: string, action: string) => void;
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

import { RemoteClient, RemoteItem } from './remote-client';

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
        if (!stats) { return undefined; }
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
        if (!stats) { return; }
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
        if (this.sftp) { return this.sftp; }
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
        if (this.config.password) { cfg.password = this.config.password; }
        const key = resolvePrivateKey(this.config.privateKey ?? this.config.identity),
            agent = resolveKeyValue(this.config.agent);
        if (key) { cfg.privateKey = key; }
        if (this.config.passphrase) { cfg.passphrase = this.config.passphrase; }
        if (agent) { cfg.agent = agent; }
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
                    if (isMissingError(err)) { resolve(undefined); } else { reject(err); }
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
        if (dir === '' || dir === '/' || dir === '.') { return; }
        const sftp = await this.connect(),
            exists = await this.dirExists(dir);
        if (exists) { return; }
        const parent = path.posix.dirname(dir);
        if (parent !== dir) { await this.ensureRemoteDir(parent); }
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
                    if (isMissingError(err)) { resolve(false); } else { reject(err); }
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
        if (this.connected) { return; }
        if (this.config.ftpPassive) { this.client.prepareTransfer = enterPassiveModeIPv4; }
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
 * Creates a RemoteClient for the configured connection mode.
 * @param config - The SFTP configuration.
 * @param tshPath - The tsh binary path, required for Teleport mode.
 * @returns {RemoteClient} The created client.
 */
function createRemoteClient(config: SftpConfig, tshPath?: string): RemoteClient {
    const mode = resolveMode(config);
    if (mode === 'ftp') { return new FtpClient(config); }
    if (mode === 'teleport') {
        if (!tshPath) { throw new Error('tsh path is required for Teleport mode'); }
        return new TeleportClient(config, tshPath);
    }
    return new SftpClient(config);
}

/**
 * Runs an action with a connected RemoteClient and ensures cleanup.
 * @param config - The SFTP configuration.
 * @param action - A function that receives the client and returns a value.
 * @returns {Promise<T>} The action result.
 */
async function withRemoteClient<T>(
    config: SftpConfig,
    action: (client: RemoteClient) => Promise<T>
): Promise<T> {
    if (resolveMode(config) === 'teleport') {
        await tsh.ensureTeleportSession(config);
    }
    const tshPath = resolveMode(config) === 'teleport' ? await tsh.getTshPath() : undefined,
        client = createRemoteClient(config, tshPath);
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
async function runRemoteAction<T>(
    config: SftpConfig,
    action: (client: RemoteClient) => Promise<T>
): Promise<T> {
    validateConfig(config);
    return withRemoteClient(config, action);
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
            ig = ignore().add(getIgnorePatterns(this.config.ignore)),
            queue = new PQueue({ concurrency });

        await client.mkdir(remoteRoot);

        const [localFiles, remoteFiles] = await Promise.all([
            this.collectLocalFiles(localRoot, ig),
            this.collectRemoteFiles(client, remoteRoot, queue, ig),
        ]);

        const plan = this.buildPlan(localFiles, remoteFiles);
        const report = this.formatReport(plan);

        if (options.dryRun) { return `DRY RUN\n${report}`; }

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

        /**
         * Recursively walks a local directory and populates the files map.
         * @param dir - The absolute directory to walk.
         * @param dirRel - The directory's relative path from the root.
         * @returns {Promise<void>}
         */
        const walk = async (dir: string, dirRel: string) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
                if (ig.ignores(rel)) { continue; }
                const full = path.join(dir, e.name),
                    stat = await fs.promises.stat(full),
                    item: FileItem = {
                        rel,
                        size: stat.size,
                        modifyTime: stat.mtimeMs,
                        isDirectory: stat.isDirectory(),
                    };
                files.set(rel, item);
                if (e.isDirectory()) { await walk(full, rel); }
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

        /**
         * Recursively lists a remote directory and populates the files map.
         * @param dirRel - The directory's relative path from the root.
         * @returns {Promise<void>}
         */
        const visit = async (dirRel: string) => {
            const full = dirRel ? path.posix.join(remoteRoot, dirRel) : remoteRoot,
                entries = await client.list(full);
            for (const e of entries) {
                if (e.name === '.' || e.name === '..') { continue; }
                const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
                if (ig.ignores(rel)) { continue; }
                if (e.isDirectory) {
                    queue.add(() => visit(rel).catch((err) => errors.push(err)));
                } else {
                    files.set(rel, { rel, size: e.size, modifyTime: e.modifyTime, isDirectory: false });
                }
            }
        };

        queue.add(() => visit('').catch((err) => errors.push(err)));
        await queue.onIdle();

        if (errors.length > 0) { throw errors[0]; }
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
            if (remoteSeconds > 0 && localSeconds > remoteSeconds) { upload.push(rel); }
        }

        for (const rel of remoteFiles.keys()) {
            if (!localFiles.has(rel)) { remove.push(rel); }
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
            jobs: Promise<void>[] = [];

        /**
         * Reports progress for a completed sync action.
         * @param file - The affected file or directory.
         * @param action - The action that completed.
         * @returns {void}
         */
        const notify = (file: string, action: string) => {
            if (onProgress) { current += 1; onProgress(current, total, file, action); }
        };

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
    if (rel.startsWith('..') || rel === '') { throw new Error('File is outside the configured local path'); }
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
        if (remoteItem.isDirectory) { throw new Error('Cannot sync a directory'); }
        const localSeconds = Math.floor(localStat.mtimeMs / 1000),
            remoteSeconds = Math.floor(remoteItem.modifyTime / 1000);
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
 * Tests the configured connection for the current mode.
 * @param config - The SFTP configuration.
 * @returns {Promise<string>} The test result.
 */
export async function testConnection(config: SftpConfig): Promise<string> {
    const mode = resolveMode(config);
    if (mode === 'ftp' && !config.ftpHost) { throw new Error('FTP host is required'); }
    if (mode === 'sftp' && (!config.sftpHost || !config.sftpUser)) { throw new Error('SFTP host and user are required'); }
    if (mode === 'teleport' && (!config.teleportHost || !config.teleportUser)) { throw new Error('Teleport host and user are required'); }
    return withRemoteClient(config, async (client) => {
        await client.test();
        return 'Connection successful';
    });
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
    if (missing.length > 0) { throw new Error(`Missing required configuration: ${missing.join(', ')}`); }
}
