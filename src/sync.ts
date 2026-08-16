import * as cp from 'child_process';
import { resolveMode, SftpConfig } from './config';

const SESSION_CACHE_MS = 60000;

let cachedSession: { configKey: string; output: string; validUntil: number } | undefined;

export interface SyncOptions {
    dryRun?: boolean;
    cwd?: string;
}

export interface SyncCommand {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

/**
 * Builds the appropriate sync command for the resolved connection mode.
 * @param config - The SFTP/teleport configuration.
 * @param options - Optional sync options.
 * @returns {SyncCommand} The command, arguments, and environment.
 */
export function buildSyncCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const mode = resolveMode(config);
    if (mode === 'ftp') {
        return buildFtpCommand(config, options);
    }
    if (mode === 'sftp' && config.useRsync) {
        return buildRsyncCommand(config, options);
    }
    if (mode === 'sftp') {
        return buildSftpLftpCommand(config, options);
    }
    return buildRsyncCommand(config, options);
}

/**
 * Builds an rsync command for the given configuration.
 * @param config - The SFTP/teleport configuration.
 * @param options - Optional sync options.
 * @returns {SyncCommand} The rsync command details.
 */
export function buildRsyncCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const args: string[] = ['-avz', '--delete'];

    if (options.dryRun) {
        args.push('-n');
    }

    if (config.rsyncFlags) {
        args.push(...config.rsyncFlags.split(' ').filter(Boolean));
    }

    const local = (config.localPath || '').replace(/\/+$/, '') + '/',
        remotePath = (config.remotePath || '').replace(/\/+$/, '') + '/';
    const remote = `${config.sftpUser}@${config.sftpHost}:${remotePath}`;
    args.push(local, remote);

    const env: NodeJS.ProcessEnv = { ...process.env };
    const mode = resolveMode(config);

    if (mode === 'teleport') {
        const cluster = config.teleportCluster ? ` --cluster=${config.teleportCluster}` : '';
        env.RSYNC_RSH = `tsh ssh${cluster}`;
    } else {
        const sshArgs: string[] = ['ssh'];
        if (config.sftpPort && config.sftpPort !== 22) {
            sshArgs.push('-p', String(config.sftpPort));
        }
        if (config.identity) {
            sshArgs.push('-i', config.identity);
        }
        if (config.sshFlags) {
            sshArgs.push(...config.sshFlags.split(' ').filter(Boolean));
        }
        env.RSYNC_RSH = sshArgs.length > 1 ? sshArgs.join(' ') : 'ssh';
    }

    return { command: 'rsync', args, env };
}

/**
 * Builds an lftp command for an FTP sync.
 * @param config - The FTP configuration.
 * @param options - Optional sync options.
 * @returns {SyncCommand} The lftp command details.
 */
export function buildFtpCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const user = config.ftpUser || 'anonymous',
        pass = config.password || '',
        host = config.ftpHost || '',
        port = config.ftpPort || 21,
        hostWithPort = port !== 21 ? `${host}:${port}` : host,
        local = (config.localPath || '').replace(/\/+$/, ''),
        remote = (config.remotePath || '').replace(/\/+$/, '');

    const script = options.dryRun
        ? `set ssl:verify-certificate no; open -u "${user}","${pass}" "${hostWithPort}"; ls "${remote}"; bye`
        : `set ssl:verify-certificate no; open -u "${user}","${pass}" "${hostWithPort}"; mirror -R -c -e -p -v "${local}" "${remote}"; bye`;

    return { command: 'lftp', args: ['-c', script], env: process.env };
}

/**
 * Builds an lftp command for an SFTP sync.
 * @param config - The SFTP configuration.
 * @param options - Optional sync options.
 * @returns {SyncCommand} The lftp command details.
 */
export function buildSftpLftpCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const user = config.sftpUser || '',
        pass = config.password || '',
        host = config.sftpHost || '',
        port = config.sftpPort || 22,
        server = port !== 22 ? `sftp://${host}:${port}` : `sftp://${host}`,
        local = (config.localPath || '').replace(/\/+$/, ''),
        remote = (config.remotePath || '').replace(/\/+$/, '');

    let connectProgram = 'ssh -a -x';
    if (config.identity) { connectProgram += ` -i ${config.identity}`; }
    if (config.sftpPort && config.sftpPort !== 22) { connectProgram += ` -p ${config.sftpPort}`; }
    if (config.sshFlags) { connectProgram += ` ${config.sshFlags}`; }

    const script = options.dryRun
        ? `set sftp:auto-confirm yes; set sftp:connect-program "${connectProgram}"; open -u "${user}","${pass}" "${server}"; ls "${remote}"; bye`
        : `set sftp:auto-confirm yes; set sftp:connect-program "${connectProgram}"; open -u "${user}","${pass}" "${server}"; mirror -R -c -e -p -v "${local}" "${remote}"; bye`;

    return { command: 'lftp', args: ['-c', script], env: process.env };
}

/**
 * Executes a sync using the resolved command for the configuration.
 * @param config - The SFTP/teleport configuration.
 * @param options - Optional sync options.
 * @returns {Promise<string>} The command output.
 */
export function runSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    const { command, args, env } = buildSyncCommand(config, options);
    return spawnCommand(command, args, { env, cwd: options.cwd });
}

/**
 * Tests whether the Teleport CLI is logged in.
 * @param _config - The configuration (unused).
 * @returns {Promise<string>} The tsh status output.
 */
export function testTeleport(_config: SftpConfig): Promise<string> {
    return spawnCommand('tsh', ['status'], { env: process.env });
}

/**
 * Tests connectivity for the resolved connection mode.
 * @param config - The SFTP/teleport configuration.
 * @returns {Promise<string>} The test output.
 */
export function testConnection(config: SftpConfig): Promise<string> {
    const mode = resolveMode(config);
    if (mode === 'teleport') { return testTeleport(config); }
    if (mode === 'ftp') { return testFtp(config); }
    if (mode === 'sftp') { return config.useRsync ? testSftpRsync(config) : testSftpLftp(config); }
    throw new Error(`Unknown mode: ${mode}`);
}

/**
 * Tests an FTP connection using lftp.
 * @param config - The FTP configuration.
 * @returns {Promise<string>} The connection output.
 */
function testFtp(config: SftpConfig): Promise<string> {
    if (!config.ftpHost) { throw new Error('FTP host is required'); }
    const user = config.ftpUser || 'anonymous',
        pass = config.password || '',
        host = config.ftpHost,
        port = config.ftpPort || 21,
        hostWithPort = port !== 21 ? `${host}:${port}` : host;
    const script = `set ssl:verify-certificate no; open -u "${user}","${pass}" "${hostWithPort}"; ls; bye`;
    return spawnCommand('lftp', ['-c', script], { env: process.env });
}

/**
 * Tests an SFTP connection using rsync/ssh.
 * @param config - The SFTP configuration.
 * @returns {Promise<string>} The test output.
 */
function testSftpRsync(config: SftpConfig): Promise<string> {
    if (!config.sftpHost || !config.sftpUser) { throw new Error('SFTP host and user are required'); }
    const port = config.sftpPort || 22;
    const args = ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes'];
    if (port !== 22) { args.push('-p', String(port)); }
    args.push(`${config.sftpUser}@${config.sftpHost}`, 'echo', 'SFTP_OK');
    return spawnCommand('ssh', args, { env: process.env });
}

/**
 * Tests an SFTP connection using lftp.
 * @param config - The SFTP configuration.
 * @returns {Promise<string>} The test output.
 */
function testSftpLftp(config: SftpConfig): Promise<string> {
    if (!config.sftpHost || !config.sftpUser) { throw new Error('SFTP host and user are required'); }
    const { command, args } = buildSftpLftpCommand(config, { dryRun: true });
    return spawnCommand(command, args, { env: process.env });
}

export interface LoginOptions {
    onLink?: (url: string) => void;
}

/**
 * Logs into Teleport via the tsh CLI, optionally reporting login links.
 * @param config - The Teleport configuration.
 * @param options - Optional login callbacks.
 * @returns {Promise<string>} The tsh login output.
 */
export function loginToTeleport(config: SftpConfig, options: LoginOptions = {}): Promise<string> {
    const args: string[] = ['login'];
    if (config.teleportHost) { args.push(`--proxy=${config.teleportHost}`); }
    if (config.teleportUser) { args.push(`--user=${config.teleportUser}`); }
    if (config.teleportCluster) { args.push(config.teleportCluster); }

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

/**
 * Ensures an active Teleport session, logging in if necessary and caching the result.
 * @param config - The Teleport configuration.
 * @param options - Optional login callbacks.
 * @returns {Promise<string>} The session output.
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
 * Returns installation instructions for the given command.
 * @param command - The command name.
 * @returns {string} Human-readable installation guidance.
 */
function getInstallHint(command: string): string {
    switch (command) {
        case 'lftp':
            return 'To install lftp:\n- macOS: brew install lftp\n- Debian/Ubuntu: sudo apt-get install lftp';
        case 'rsync':
            return 'To install rsync:\n- macOS: brew install rsync\n- Debian/Ubuntu: sudo apt-get install rsync';
        case 'tsh':
            return 'To install the Teleport client, see: https://goteleport.com/docs/installation/';
        case 'ssh':
            return 'OpenSSH client is missing. Install it via your system package manager.';
        default:
            return 'Install the required tool and ensure it is in your PATH.';
    }
}

/**
 * Spawns a child process and captures its stdout output.
 * @param command - The command to run.
 * @param args - The command arguments.
 * @param options - Optional environment and working directory.
 * @returns {Promise<string>} The command's stdout output.
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
                reject(new Error(`${command} is not installed or not in PATH.\n${getInstallHint(command)}`));
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

/**
 * Validates that all required fields are present for the resolved mode.
 * @param config - The SFTP/teleport configuration.
 * @returns {void}
 */
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
