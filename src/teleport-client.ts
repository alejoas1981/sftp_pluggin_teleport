import { RemoteClient, RemoteItem } from './remote-client';
import { SftpConfig } from './config';
import { ensureLocalDir, escapeShell, normalizeRemotePath } from './utils';
import { runTshCommand } from './tsh';

/**
 * Executes a tsh command and returns its stdout.
 */
export type TshRunner = (args: string[]) => Promise<string>;

/**
 * SFTP-like client that uses the tsh binary for Teleport file transfers.
 */
export class TeleportClient implements RemoteClient {
    private config: SftpConfig;
    private tshPath: string;
    private runTsh: TshRunner;

    /**
     * Creates a new Teleport client.
     * @param config - The SFTP configuration.
     * @param tshPath - The absolute path to the tsh executable.
     * @param runTsh - Optional command runner override for testing.
     */
    constructor(
        config: SftpConfig,
        tshPath: string,
        runTsh: TshRunner = (args) => runTshCommand(args, { tshPath })
    ) {
        this.config = config;
        this.tshPath = tshPath;
        this.runTsh = runTsh;
    }

    /**
     * Tests the Teleport connection by running a remote echo.
     * @returns {Promise<void>}
     */
    async test(): Promise<void> {
        const args = this.sshArgs(`echo ok`);
        await this.runTsh(args);
    }

    /**
     * Gets metadata for a remote file or directory.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    async stat(remotePath: string): Promise<RemoteItem | undefined> {
        const escaped = escapeShell(normalizeRemotePath(remotePath));
        const command = `stat -c '%s %Y %F' ${escaped}`;
        try {
            const output = await this.runTsh(this.sshArgs(command));
            const parts = output.trim().split(' ');
            const size = parseInt(parts[0], 10) || 0,
                mtime = parseInt(parts[1], 10) || 0,
                type = parts.slice(2).join(' ');
            return {
                name: remotePath.split('/').pop() || '',
                size,
                modifyTime: mtime * 1000,
                isDirectory: type.includes('directory'),
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
        const dir = escapeShell(normalizeRemotePath(remoteDir));
        const command = `find ${dir} -maxdepth 1 -mindepth 1 -printf '%f\\t%s\\t%T@\\t%y\\n'`;
        try {
            const output = await this.runTsh(this.sshArgs(command));
            const items: RemoteItem[] = [];
            for (const line of output.split('\n')) {
                const [name, size, mtime, type] = line.split('\t');
                if (!name) { continue; }
                items.push({
                    name,
                    size: parseInt(size, 10) || 0,
                    modifyTime: Math.floor(parseFloat(mtime) * 1000) || 0,
                    isDirectory: type === 'd',
                });
            }
            return items;
        } catch {
            return [];
        }
    }

    /**
     * Uploads a local file to the remote host via tsh scp.
     * @param localPath - The local file path.
     * @param remotePath - The remote destination path.
     * @returns {Promise<void>}
     */
    async put(localPath: string, remotePath: string): Promise<void> {
        const remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${normalizeRemotePath(remotePath)}`;
        await this.runTsh(this.scpArgs(localPath, remoteSpec, 'put'));
    }

    /**
     * Downloads a remote file to the local path via tsh scp.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    async get(remotePath: string, localPath: string): Promise<void> {
        ensureLocalDir(localPath);
        const remoteSpec = `${this.config.sftpUser}@${this.config.sftpHost}:${normalizeRemotePath(remotePath)}`;
        await this.runTsh(this.scpArgs(remoteSpec, localPath, 'get'));
    }

    /**
     * Creates a directory on the remote host.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    async mkdir(remotePath: string): Promise<void> {
        const escaped = escapeShell(normalizeRemotePath(remotePath));
        await this.runTsh(this.sshArgs(`mkdir -p ${escaped}`));
    }

    /**
     * Deletes a remote file.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    async delete(remotePath: string): Promise<void> {
        const escaped = escapeShell(normalizeRemotePath(remotePath));
        await this.runTsh(this.sshArgs(`rm -f ${escaped}`));
    }

    /**
     * Closes the client; each tsh command is independent.
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {
        // stateless
    }

    /**
     * Builds the tsh ssh argument list for a remote command.
     * @param command - The command to execute on the remote host.
     * @returns {string[]} The argument list.
     */
    private sshArgs(command: string): string[] {
        const args: string[] = [];
        if (this.config.teleportHost) { args.push(`--proxy=${this.config.teleportHost}`); }
        if (this.config.teleportCluster) { args.push(`--cluster=${this.config.teleportCluster}`); }
        args.push('ssh');
        const port = this.config.sftpPort ?? 22;
        if (port !== 22) { args.push('-p', String(port)); }
        args.push(`${this.config.sftpUser}@${this.config.sftpHost}`, command);
        return args;
    }

    /**
     * Builds the tsh scp argument list for an upload or download.
     * @param src - The source path or remote spec.
     * @param dst - The destination path or remote spec.
     * @returns {string[]} The argument list.
     */
    private scpArgs(src: string, dst: string, _direction: 'put' | 'get'): string[] {
        const args: string[] = [];
        if (this.config.teleportHost) { args.push(`--proxy=${this.config.teleportHost}`); }
        if (this.config.teleportCluster) { args.push(`--cluster=${this.config.teleportCluster}`); }
        args.push('scp');
        const port = this.config.sftpPort ?? 22;
        if (port !== 22) { args.push('-P', String(port)); }
        args.push(src, dst);
        return args;
    }
}
