import * as cp from 'child_process';
import { SftpConfig } from './config';

export interface SyncOptions {
    dryRun?: boolean;
    cwd?: string;
}

export interface SyncCommand {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

export function buildRsyncCommand(config: SftpConfig, options: SyncOptions = {}): SyncCommand {
    const args: string[] = ['-avz', '--delete'];

    if (options.dryRun) {
        args.push('-n');
    }

    if (config.rsyncFlags) {
        args.push(...config.rsyncFlags.split(' ').filter(Boolean));
    }

    const local = (config.localPath || '').replace(/\/+$/, '') + '/';
    const remotePath = (config.remotePath || '').replace(/\/+$/, '') + '/';
    const remote = `${config.sftpUser}@${config.sftpHost}:${remotePath}`;
    args.push(local, remote);

    const env: NodeJS.ProcessEnv = { ...process.env };

    if (config.useTeleport !== false) {
        const cluster = config.teleportCluster ? ` --cluster=${config.teleportCluster}` : '';
        env.RSYNC_RSH = `tsh ssh${cluster}`;
    } else if (config.identity) {
        env.RSYNC_RSH = `ssh -i ${config.identity}`;
    }

    return { command: 'rsync', args, env };
}

export function runSync(config: SftpConfig, options: SyncOptions = {}): Promise<string> {
    validateConfig(config);
    const { command, args, env } = buildRsyncCommand(config, options);
    return spawnCommand(command, args, { env, cwd: options.cwd });
}

export function testTeleport(_config: SftpConfig): Promise<string> {
    return spawnCommand('tsh', ['status'], { env: process.env });
}

function spawnCommand(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn(command, args, { env: options.env, cwd: options.cwd });
        let stdout = '';
        let stderr = '';
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
    const missing: string[] = [];
    if (!config.sftpHost) { missing.push('sftpHost'); }
    if (!config.sftpUser) { missing.push('sftpUser'); }
    if (!config.remotePath) { missing.push('remotePath'); }
    if (!config.localPath) { missing.push('localPath'); }
    if (missing.length > 0) {
        throw new Error(`Missing required configuration: ${missing.join(', ')}`);
    }
}
