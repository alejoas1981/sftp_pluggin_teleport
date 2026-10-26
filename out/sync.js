"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncEngine = void 0;
exports.cancelActiveTransfer = cancelActiveTransfer;
exports.runSync = runSync;
exports.uploadChangedFiles = uploadChangedFiles;
exports.uploadFile = uploadFile;
exports.downloadFile = downloadFile;
exports.deleteRemoteFile = deleteRemoteFile;
exports.syncFile = syncFile;
exports.testTeleport = testTeleport;
exports.testConnection = testConnection;
exports.loginToTeleport = loginToTeleport;
exports.ensureTeleportSession = ensureTeleportSession;
exports.validateConfig = validateConfig;
const rsync_options_1 = require("./rsync-options");
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const basic_ftp_1 = require("basic-ftp");
const p_queue_1 = __importDefault(require("p-queue"));
const ssh2_1 = require("ssh2");
const config_1 = require("./config");
const utils_1 = require("./utils");
const teleport_installer_1 = require("./teleport-installer");
const sync_engine_1 = require("./sync-engine");
var sync_engine_2 = require("./sync-engine");
Object.defineProperty(exports, "SyncEngine", { enumerable: true, get: function () { return sync_engine_2.SyncEngine; } });
const SESSION_CACHE_MS = 60000, remoteActionQueue = new p_queue_1.default({ concurrency: 1 });
let cachedSession, activeTransferController;
function cancelActiveTransfer() {
    if (!activeTransferController || activeTransferController.signal.aborted) {
        return false;
    }
    activeTransferController.abort();
    return true;
}
/**
 * Checks whether the given error represents a missing file.
 * @param err - The error to inspect.
 * @returns {boolean} True when the error indicates no such file.
 */
function isMissingError(err) {
    const code = err.code;
    if (code === 2) {
        return true;
    }
    return /NO_SUCH_FILE|No such file/i.test(err.message);
}
/**
 * SFTP client implementation using ssh2.
 */
class SftpClient {
    /**
     * Creates a new SFTP client.
     * @param config - The SFTP configuration.
     */
    constructor(config, signal) {
        this.config = config;
        this.signal = signal;
        signal?.addEventListener('abort', () => { void this.close(); }, { once: true });
    }
    /**
     * Tests the SFTP connection by listing the remote root.
     * @returns {Promise<void>}
     */
    async test() {
        await this.connect();
        await this.list('.');
    }
    /**
     * Gets metadata for a remote file or directory.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath) {
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
    async list(remoteDir) {
        const sftp = await this.connect();
        return new Promise((resolve, reject) => {
            sftp.readdir(remoteDir, (err, list) => {
                if (err) {
                    if (isMissingError(err)) {
                        resolve([]);
                    }
                    else {
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
    async put(localPath, remotePath) {
        const sftp = await this.connect();
        await this.ensureRemoteDir(path.posix.dirname(remotePath));
        return new Promise((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
        });
    }
    /**
     * Downloads a remote file to the local path.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath, localPath) {
        const sftp = await this.connect();
        (0, utils_1.ensureLocalDir)(localPath);
        return new Promise((resolve, reject) => {
            sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
        });
    }
    /**
     * Creates a directory on the remote server.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath) {
        const sftp = await this.connect();
        await this.ensureRemoteDir(remotePath);
    }
    /**
     * Deletes a remote file or directory.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath) {
        const sftp = await this.connect(), stats = await this.sftpStat(remotePath);
        if (!stats) {
            return;
        }
        return new Promise((resolve, reject) => {
            const cb = (err) => (err ? reject(err) : resolve());
            stats.isDirectory() ? sftp.rmdir(remotePath, cb) : sftp.unlink(remotePath, cb);
        });
    }
    /**
     * Closes the underlying SSH connection.
     * @returns {Promise<void>}
     */
    async close() {
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
    async connect() {
        if (this.signal?.aborted) {
            throw new Error('Transfer cancelled');
        }
        if (this.sftp) {
            return this.sftp;
        }
        this.client = new ssh2_1.Client();
        const config = this.buildConfig();
        return new Promise((resolve, reject) => {
            this.client.on('error', (err) => reject(err));
            this.client.once('ready', () => {
                this.client.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    // Keep the error listener installed for connection failures after readiness.
                    this.sftp = sftp;
                    resolve(sftp);
                });
            });
            this.client.connect(config);
        });
    }
    /**
     * Builds the ssh2 connection configuration.
     * @returns {any} The ssh2 client options.
     */
    buildConfig() {
        const cfg = {
            host: this.config.sftpHost,
            port: this.config.sftpPort ?? 22,
            username: this.config.sftpUser,
        };
        if (this.config.password) {
            cfg.password = this.config.password;
        }
        const key = (0, utils_1.resolvePrivateKey)(this.config.privateKey ?? this.config.identity), agent = (0, utils_1.resolveKeyValue)(this.config.agent);
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
    async sftpStat(remotePath) {
        const sftp = await this.connect();
        return new Promise((resolve, reject) => {
            sftp.lstat(remotePath, (err, stats) => {
                if (err) {
                    if (isMissingError(err)) {
                        resolve(undefined);
                    }
                    else {
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
    async ensureRemoteDir(dir) {
        if (dir === '' || dir === '/' || dir === '.') {
            return;
        }
        const sftp = await this.connect(), exists = await this.dirExists(dir);
        if (exists) {
            return;
        }
        const parent = path.posix.dirname(dir);
        if (parent !== dir) {
            await this.ensureRemoteDir(parent);
        }
        return new Promise((resolve, reject) => {
            sftp.mkdir(dir, (err) => (err ? reject(err) : resolve()));
        });
    }
    /**
     * Checks whether a remote directory exists.
     * @param dir - The remote directory path.
     * @returns {Promise<boolean>} True when the directory exists.
     */
    async dirExists(dir) {
        const sftp = await this.connect();
        return new Promise((resolve, reject) => {
            sftp.stat(dir, (err, stats) => {
                if (err) {
                    if (isMissingError(err)) {
                        resolve(false);
                    }
                    else {
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
class FtpClient {
    /**
     * Creates a new FTP client.
     * @param config - The SFTP configuration.
     */
    constructor(config, signal) {
        this.connected = false;
        this.operations = new p_queue_1.default({ concurrency: 1 });
        this.loginDirectory = "/";
        this.config = config;
        this.signal = signal;
        this.client = new basic_ftp_1.Client();
        signal?.addEventListener('abort', () => {
            this.client.close();
            this.connected = false;
        }, { once: true });
    }
    /**
     * Tests the FTP connection by listing the remote root.
     * @returns {Promise<void>}
     */
    async test() {
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
    async stat(remotePath) {
        return this.operations.add(async () => {
            await this.connect();
            remotePath = path.posix.resolve(this.loginDirectory, remotePath);
            try {
                const size = await this.client.size(remotePath), mtime = await this.client.lastMod(remotePath);
                return {
                    name: path.posix.basename(remotePath),
                    size,
                    modifyTime: mtime ? mtime.getTime() : 0,
                    isDirectory: false,
                };
            }
            catch (error) {
                if (error.code === 550) {
                    const entries = await this.client.list(path.posix.dirname(remotePath)), entry = entries.find((item) => item.name === path.posix.basename(remotePath));
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
    async list(remoteDir) {
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
    async put(localPath, remotePath) {
        return this.operations.add(async () => {
            await this.connect();
            remotePath = path.posix.resolve(this.loginDirectory, remotePath);
            const parent = path.posix.dirname(remotePath), base = path.posix.basename(remotePath);
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
    async get(remotePath, localPath) {
        return this.operations.add(async () => {
            await this.connect();
            (0, utils_1.ensureLocalDir)(localPath);
            await this.client.downloadTo(localPath, path.posix.resolve(this.loginDirectory, remotePath));
        });
    }
    /**
     * Creates a directory on the FTP server.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath) {
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
    async delete(remotePath) {
        return this.operations.add(async () => {
            await this.connect();
            remotePath = path.posix.resolve(this.loginDirectory, remotePath);
            const parent = path.posix.dirname(remotePath), base = path.posix.basename(remotePath);
            await this.client.ensureDir(parent);
            await this.client.remove(base, true);
        });
    }
    /**
     * Closes the FTP connection.
     * @returns {Promise<void>}
     */
    async close() {
        await this.operations.onIdle();
        this.client.close();
        this.connected = false;
    }
    /**
     * Connects to the FTP server.
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.signal?.aborted) {
            throw new Error('Transfer cancelled');
        }
        if (this.connected) {
            return;
        }
        if (this.config.ftpPassive) {
            this.client.prepareTransfer = basic_ftp_1.enterPassiveModeIPv4;
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
    mapFileInfo(info) {
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
class FtpPool {
    constructor(config, signal) {
        this.config = config;
        this.signal = signal;
        this.clients = [];
        this.available = [];
        this.queue = new p_queue_1.default({ concurrency: Math.max((0, utils_1.transferConcurrency)(config.concurrency), (0, utils_1.transferConcurrency)(config.scanConcurrency)) });
    }
    async use(action) {
        return this.queue.add(async () => {
            let client = this.available.pop();
            if (!client) {
                client = new FtpClient(this.config, this.signal);
                this.clients.push(client);
            }
            try {
                return await action(client);
            }
            finally {
                this.available.push(client);
            }
        });
    }
    test() { return this.use((client) => client.test()); }
    list(directory) { return this.use((client) => client.list(directory)); }
    stat(file) { return this.use((client) => client.stat(file)); }
    put(local, remote) { return this.use((client) => client.put(local, remote)); }
    get(remote, local) { return this.use((client) => client.get(remote, local)); }
    mkdir(directory) { return this.use((client) => client.mkdir(directory)); }
    delete(file) { return this.use((client) => client.delete(file)); }
    async close() {
        await this.queue.onIdle();
        await Promise.all(this.clients.map((client) => client.close()));
    }
}
/**
 * Escapes a shell argument by wrapping it in single quotes.
 * @param arg - The argument to escape.
 * @returns {string} The escaped argument.
 */
function escapeShell(arg) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
/**
 * Runs a tsh ssh command with the configured Teleport options.
 * @param config - The SFTP configuration.
 * @param command - The command to execute on the remote host.
 * @param rawOutput - Preserve stdout whitespace and null separators.
 * @param signal - Optional cancellation signal.
 * @param input - Optional data forwarded to the remote command through stdin.
 * @returns {Promise<string>} The command output.
 */
async function runTshCommand(config, command, rawOutput = false, signal, input) {
    const tshPath = await (0, teleport_installer_1.ensureTsh)();
    const args = ['ssh'];
    if (config.teleportCluster) {
        args.push('--cluster', config.teleportCluster);
    }
    args.push(`${config.sftpUser}@${config.sftpHost}`, command);
    return spawnCommand(tshPath, args, { env: process.env, rawOutput, signal, input });
}
/**
 * Teleport client implementation using tsh and rsync.
 */
class TeleportClient {
    /**
     * Creates a new Teleport client.
     * @param config - The SFTP configuration.
     */
    constructor(config, signal) {
        this.signal = signal;
        this.config = config;
    }
    /**
     * Tests the Teleport connection by running a remote echo.
     * @returns {Promise<void>}
     */
    async test() {
        await runTshCommand(this.config, 'echo ok', false, this.signal);
    }
    /**
     * Gets metadata for a remote file using tsh stat.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath) {
        const p = escapeShell(remotePath);
        try {
            const output = await runTshCommand(this.config, `LC_ALL=C stat -c '%s %Y %F' -- ${p}`, false, this.signal), parts = output.trim().split(' '), size = parseInt(parts[0], 10) || 0, mtime = parseInt(parts[1], 10) || 0, type = parts.slice(2).join(' ');
            return {
                name: path.posix.basename(remotePath),
                size,
                modifyTime: mtime * 1000,
                isDirectory: type.includes('directory'),
                isSymbolicLink: type.includes('symbolic link'),
            };
        }
        catch (error) {
            if (/cannot stat.*No such file or directory/s.test(error.message)) {
                return undefined;
            }
            throw error;
        }
    }
    /**
     * Reads metadata for many paths without placing those paths in the SSH command line.
     * @param remotePaths - Absolute remote paths to inspect in input order.
     * @returns Metadata keyed by the requested remote path.
     */
    async statMany(remotePaths) {
        if (remotePaths.length === 0) {
            return new Map();
        }
        const command = `xargs -0 -n 1 sh -c 'p="$1"; if [ -L "$p" ]; then printf "0 0 symbolic-link\\n"; `
            + `elif [ -d "$p" ]; then LC_ALL=C stat -c "%s %Y directory" -- "$p"; `
            + `elif [ -f "$p" ]; then LC_ALL=C stat -c "%s %Y regular-file" -- "$p"; `
            + `else printf "0 0 missing\\n"; fi' sh`, input = Buffer.from(`${remotePaths.join('\0')}\0`), output = await runTshCommand(this.config, command, false, this.signal, input), lines = output.split('\n');
        if (lines.length !== remotePaths.length) {
            throw new Error('Incomplete Teleport metadata response');
        }
        return new Map(remotePaths.map((remotePath, index) => {
            const [size, mtime, type] = lines[index].split(' ');
            if (type === 'missing') {
                return [remotePath, undefined];
            }
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
    async list(remoteDir) {
        const dir = escapeShell((0, utils_1.normalizeRemotePath)(remoteDir)), output = await runTshCommand(this.config, `find ${dir} -maxdepth 1 -mindepth 1 -printf '%f\\0%s\\0%T@\\0%y\\0'`, true, this.signal), items = [];
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
     * Reads the complete remote tree through one Teleport command.
     * @param remoteDir - Remote root directory to traverse.
     * @returns Map keyed by paths relative to the requested root.
     */
    async listTree(remoteDir) {
        const dir = escapeShell((0, utils_1.normalizeRemotePath)(remoteDir)), output = await runTshCommand(this.config, `LC_ALL=C find ${dir} -mindepth 1 -printf '%P\\0%s\\0%T@\\0%y\\0'`, true, this.signal), fields = output.split('\0'), items = new Map();
        for (let index = 0; index + 3 < fields.length; index += 4) {
            const [relative, size, mtime, type] = fields.slice(index, index + 4);
            if (!relative) {
                continue;
            }
            const normalized = path.posix.normalize(relative);
            if (normalized !== relative || relative.startsWith('/') || /[\\\0]/.test(relative)
                || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
                throw new Error(`Unsafe remote path: ${JSON.stringify(relative)}`);
            }
            items.set(relative, {
                name: path.posix.basename(relative),
                size: parseInt(size, 10) || 0,
                modifyTime: Math.floor(parseFloat(mtime) * 1000) || 0,
                isDirectory: type === 'd',
                isSymbolicLink: type !== 'd' && type !== 'f'
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
    async put(localPath, remotePath) {
        await this.putMany([{ localPath, remotePath }]);
    }
    async putMany(files) {
        if (files.length === 0) {
            return;
        }
        const args = await this.getRsyncArgs(), localRoot = path.resolve(this.config.localPath), remoteRoot = (0, utils_1.normalizeRemotePath)(this.config.remotePath), sources = files.map(({ localPath, remotePath }) => {
            const relativeLocal = path.relative(localRoot, localPath).replace(/\\/g, '/'), relativeRemote = path.posix.relative(remoteRoot, remotePath);
            if (!relativeLocal || relativeLocal.startsWith('../') || path.isAbsolute(relativeLocal)
                || relativeRemote !== relativeLocal) {
                throw new Error(`Unsafe Teleport upload path: ${relativeLocal || localPath}`);
            }
            return relativeLocal;
        }), destinationRoot = remoteRoot === '/' ? '/' : `${remoteRoot}/`, remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${escapeShell(destinationRoot)}`;
        await spawnCommand('rsync', [...args, '--relative', '--from0', '--files-from=-', './', remoteSpec], {
            env: process.env,
            cwd: localRoot,
            input: Buffer.from(`${sources.join('\0')}\0`),
            signal: this.signal
        });
    }
    /**
     * Downloads a remote file via rsync over tsh.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath, localPath) {
        (0, utils_1.ensureLocalDir)(localPath);
        const args = await this.getRsyncArgs(), remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${escapeShell(remotePath)}`;
        await spawnCommand('rsync', [...args, '--', remoteSpec, localPath], { env: process.env, signal: this.signal });
    }
    /**
     * Creates a directory on the remote host using tsh.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath) {
        const dir = escapeShell((0, utils_1.normalizeRemotePath)(remotePath));
        await runTshCommand(this.config, `mkdir -p ${dir}`, false, this.signal);
    }
    /**
     * Deletes a remote file using tsh.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath) {
        const p = escapeShell(remotePath);
        await runTshCommand(this.config, `rm -f ${p}`, false, this.signal);
    }
    /**
     * Closes the client; Teleport is stateless.
     * @returns {Promise<void>}
     */
    async close() {
        // stateless
    }
    /**
     * Builds the base rsync arguments for Teleport transfers.
     * @returns {Promise<string[]>} The rsync argument list.
     */
    async getRsyncArgs() {
        const tshPath = await (0, teleport_installer_1.ensureTsh)(), shell = `${escapeShell(tshPath)} ssh${this.config.teleportCluster ? ` --cluster=${escapeShell(this.config.teleportCluster)}` : ''}`, extras = (0, rsync_options_1.normalizeRsyncOptions)(this.config).rsyncFlags?.split(/\s+/).filter(Boolean) ?? [];
        return ['-rtz', '--ignore-times', '-e', shell, ...extras];
    }
}
/**
 * Creates a RemoteClient for the configured connection mode.
 * @param config - The SFTP configuration.
 * @returns {RemoteClient} The created client.
 */
function createRemoteClient(config, signal) {
    const mode = (0, config_1.resolveMode)(config);
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
async function withRemoteClient(config, action) {
    config = (0, rsync_options_1.normalizeRsyncOptions)(config);
    return remoteActionQueue.add(async () => {
        const controller = new AbortController();
        activeTransferController = controller;
        let client;
        let rejectCancellation;
        const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject; }), onAbort = () => rejectCancellation?.(new Error('Transfer cancelled'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if ((0, config_1.resolveMode)(config) === 'teleport') {
                await ensureTeleportSession(config);
            }
            client = createRemoteClient(config, controller.signal);
            return await Promise.race([action(client), cancellation]);
        }
        finally {
            controller.signal.removeEventListener('abort', onAbort);
            await client?.close();
            if (activeTransferController === controller) {
                activeTransferController = undefined;
            }
        }
    });
}
/**
 * Validates the configuration and runs an action with a RemoteClient.
 * @param config - The SFTP configuration.
 * @param action - A function that receives the client and returns a value.
 * @returns {Promise<T>} The action result.
 */
async function runRemoteAction(config, action) {
    validateConfig(config);
    return withRemoteClient(config, action);
}
/**
 * Runs a sync for the configured mode.
 * @param config - The SFTP configuration.
 * @param options - Optional sync options.
 * @returns {Promise<string>} The sync output summary.
 */
async function runSync(config, options = {}) {
    validateConfig(config);
    return withRemoteClient(config, (client) => new sync_engine_1.SyncEngine(config).sync(client, options));
}
/** Publish locally changed files without a two-way scan. */
async function uploadChangedFiles(config, options = {}) {
    validateConfig(config);
    return withRemoteClient(config, (client) => new sync_engine_1.SyncEngine(config).uploadChanged(client, options));
}
/**
 * Computes the remote path for a given local file.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {string} The remote destination path.
 */
function getRemotePath(config, localPath) {
    const root = config.localPath, rel = path.relative(root, localPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || rel === '') {
        throw new Error('File is outside the configured local path');
    }
    return path.posix.join((0, utils_1.normalizeRemotePath)(config.remotePath), rel);
}
/**
 * Uploads a local file to the remote server.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
async function uploadFile(config, localPath) {
    getRemotePath(config, localPath);
    await runRemoteAction(config, (client) => new sync_engine_1.SyncEngine(config).transferFile(client, path.relative(config.localPath, localPath).replace(/\\/g, '/'), 'upload'));
}
/**
 * Downloads a remote file to the local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
async function downloadFile(config, localPath) {
    getRemotePath(config, localPath);
    await runRemoteAction(config, (client) => new sync_engine_1.SyncEngine(config).transferFile(client, path.relative(config.localPath, localPath).replace(/\\/g, '/'), 'download'));
}
/**
 * Deletes a remote file corresponding to the local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<void>}
 */
async function deleteRemoteFile(config, localPath) {
    await runRemoteAction(config, (client) => client.delete(getRemotePath(config, localPath)));
}
/**
 * Syncs a single file with the remote server.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path.
 * @returns {Promise<string>} The sync result message.
 */
async function syncFile(config, localPath) {
    getRemotePath(config, localPath);
    return runSync(config, { files: [path.relative(config.localPath, localPath).replace(/\\/g, '/')] });
}
/**
 * Runs tsh status to verify the Teleport session.
 * @param _config - The SFTP configuration (unused).
 * @returns {Promise<string>} The tsh status output.
 */
async function testTeleport(_config) {
    const tshPath = await (0, teleport_installer_1.ensureTsh)();
    return spawnCommand(tshPath, ['status'], { env: process.env });
}
/**
 * Tests the configured connection for the current mode.
 * @param config - The SFTP configuration.
 * @returns {Promise<string>} The test result.
 */
async function testConnection(config) {
    const mode = (0, config_1.resolveMode)(config);
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
async function loginToTeleport(config, options = {}) {
    const tshPath = await (0, teleport_installer_1.ensureTsh)();
    const args = ['login', '--browser=none'];
    if (config.teleportHost) {
        args.push(`--proxy=${config.teleportHost}`);
    }
    if (config.teleportUser) {
        args.push(`--user=${config.teleportUser}`);
    }
    if (config.teleportCluster) {
        args.push(config.teleportCluster);
    }
    return new Promise((resolve, reject) => {
        const child = cp.spawn(tshPath, args, { env: process.env });
        let stdout = '', stderr = '', linkSent = false;
        const handleData = (data) => {
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
async function ensureTeleportSession(config, options = {}) {
    if ((0, config_1.resolveMode)(config) !== 'teleport') {
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
    }
    catch {
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
function validateConfig(config) {
    const mode = (0, config_1.resolveMode)(config), missing = [];
    if (mode === 'teleport') {
        if (!config.teleportHost) {
            missing.push('teleportHost');
        }
        if (!config.teleportUser) {
            missing.push('teleportUser');
        }
        if (!config.sftpHost) {
            missing.push('sftpHost');
        }
        if (!config.sftpUser) {
            missing.push('sftpUser');
        }
    }
    else if (mode === 'sftp') {
        if (!config.sftpHost) {
            missing.push('sftpHost');
        }
        if (!config.sftpUser) {
            missing.push('sftpUser');
        }
    }
    else if (mode === 'ftp') {
        if (!config.ftpHost) {
            missing.push('ftpHost');
        }
        if (!config.ftpUser) {
            missing.push('ftpUser');
        }
    }
    if (!config.remotePath) {
        missing.push('remotePath');
    }
    if (!config.localPath) {
        missing.push('localPath');
    }
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
function spawnCommand(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(command, args, { env: options.env, cwd: options.cwd, signal: options.signal });
        let stdout = '', stderr = '';
        if (options.input !== undefined) {
            child.stdin?.end(options.input);
        }
        child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; options.onOutput?.(text); });
        child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; options.onOutput?.(text); });
        child.on('error', (error) => {
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
                const rawMessage = stderr.trim() || stdout.trim() || `command exited with code ${code}`, detail = rawMessage.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ''), message = code === 255 ? `Teleport/SSH connection closed (status 255): ${detail}` : detail;
                reject(new Error(message));
                return;
            }
            resolve(options.rawOutput ? stdout : stdout.trim());
        });
    });
}
