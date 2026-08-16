import * as vscode from 'vscode';

export type ConnectionMode = 'ftp' | 'sftp' | 'teleport';

export interface SftpConfig {
    mode?: ConnectionMode;
    teleportHost?: string;
    teleportUser?: string;
    teleportCluster?: string;
    sftpHost?: string;
    sftpUser?: string;
    ftpHost?: string;
    ftpUser?: string;
    remotePath?: string;
    localPath?: string;
    identity?: string;
    password?: string;
    debounceMs?: number;
    useTeleport?: boolean;
    rsyncFlags?: string;
    sshFlags?: string;
}

const section = 'sftpPluggin';

const stringKeys: (keyof SftpConfig)[] = [
    'teleportHost', 'teleportUser', 'teleportCluster',
    'sftpHost', 'sftpUser',
    'ftpHost', 'ftpUser',
    'remotePath', 'localPath', 'identity',
    'rsyncFlags', 'sshFlags'
];

export function resolveMode(config: { mode?: ConnectionMode; useTeleport?: boolean }): ConnectionMode {
    if (config.mode) { return config.mode; }
    return config.useTeleport === false ? 'sftp' : 'teleport';
}

export function getConfiguration(): SftpConfig {
    const cfg = vscode.workspace.getConfiguration(section);
    const mode = resolveMode({
        mode: cfg.get<ConnectionMode>('mode'),
        useTeleport: cfg.get<boolean>('useTeleport')
    });
    const result: SftpConfig = { mode };
    for (const key of stringKeys) {
        (result as any)[key] = cfg.get<string>(key as string);
    }
    result.debounceMs = cfg.get<number>('debounceMs', 300);
    result.useTeleport = cfg.get<boolean>('useTeleport', true);
    return result;
}

export async function saveConfiguration(
    context: vscode.ExtensionContext,
    config: SftpConfig
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(section),
        mode = resolveMode(config);

    await cfg.update('mode', mode, true);
    for (const key of stringKeys) {
        await cfg.update(key as string, (config as any)[key], true);
    }
    await cfg.update('debounceMs', config.debounceMs, true);
    await cfg.update('useTeleport', mode === 'teleport', true);

    if (config.password !== undefined) {
        await context.secrets.store('sftpPluggin.password', config.password);
    }
}

export async function getPassword(context: vscode.ExtensionContext): Promise<string | undefined> {
    return context.secrets.get('sftpPluggin.password');
}
