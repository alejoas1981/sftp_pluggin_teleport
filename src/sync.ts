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

export function buildSyncCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const mode = resolveMode(config);
    if (mode === 'ftp') {
        return buildFtpCommand(config, options);
    }
    return buildRsyncCommand(config, options);
}

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

export function buildFtpCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const user = config.ftpUser || 'anonymous',
        pass = config.password || '',
        host = config.ftpHost || '',
        local = (config.localPath || '').replace(/\/+$/, ''),
        remote = (config.remotePath || '').replace(/\/+$/, '');

    const script = options.dryRun
        ? `set ssl:verify-certificate no; open -u "${user}","${pass}" "${host}"; ls "${remote}"; bye`
        : `set ssl:verify-certificate no; open -u "${user}","${pass}" "${host}"; mirror -R -c -e -p -v "${local}" "${remote}"; bye`;

    return { command: 'lftp', args: ['-c', script], env: process.env };
}

export function runSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    const { command, args, env } = buildSyncCommand(config, options);
    return spawnCommand(command, args, { env, cwd: options.cwd });
}

export function testTeleport(_config: SftpConfig): Promise<string> {
    return spawnCommand('tsh', ['status'], { env: process.env });
}

export interface LoginOptions {
    onLink?: (url: string) => void;
}

export function loginToTeleport(config: SftpConfig, options: LoginOptions = {}): Promise<string> {
    const args: string[] = ['login'];
    if (config.teleportHost) { args.push(`--proxy=${config.teleportHost}`); }
    if (config.teleportUser) { args.push(`--user=${config.teleportUser}`); }
    if (config.teleportCluster) { args.push(`--cluster=${config.teleportCluster}`); }

    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn('tsh', args, { env: process.env });
        let stdout = '', stderr = '';

        const handleData = (data: Buffer): string => {
            const text = data.toString();
            if (options.onLink) {
                const match = text.match(/https?:\/\/[^\s]+/);
                if (match) {
                    options.onLink(match[0]);
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
        if (out.toLowerCase().includes('not logged in')) {
            throw new Error('not logged in');
        }
        cachedSession = { configKey: key, output: out, validUntil: Date.now() + SESSION_CACHE_MS };
        return out;
    } catch {
        const out = await loginToTeleport(config, options);
        cachedSession = { configKey: key, output: out, validUntil: Date.now() + SESSION_CACHE_MS };
        return out;
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
        child.on('error', reject);
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
