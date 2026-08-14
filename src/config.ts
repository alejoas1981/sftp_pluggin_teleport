import * as vscode from 'vscode';

export interface SftpConfig {
    teleportHost?: string;
    teleportUser?: string;
    teleportCluster?: string;
    sftpHost?: string;
    sftpUser?: string;
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

export function getConfiguration(): SftpConfig {
    const cfg = vscode.workspace.getConfiguration(section);
    return {
        teleportHost: cfg.get<string>('teleportHost'),
        teleportUser: cfg.get<string>('teleportUser'),
        teleportCluster: cfg.get<string>('teleportCluster'),
        sftpHost: cfg.get<string>('sftpHost'),
        sftpUser: cfg.get<string>('sftpUser'),
        remotePath: cfg.get<string>('remotePath'),
        localPath: cfg.get<string>('localPath'),
        identity: cfg.get<string>('identity'),
        debounceMs: cfg.get<number>('debounceMs', 300),
        useTeleport: cfg.get<boolean>('useTeleport', true),
        rsyncFlags: cfg.get<string>('rsyncFlags'),
        sshFlags: cfg.get<string>('sshFlags'),
    };
}

export async function saveConfiguration(
    context: vscode.ExtensionContext,
    config: SftpConfig
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(section);
    await cfg.update('teleportHost', config.teleportHost, true);
    await cfg.update('teleportUser', config.teleportUser, true);
    await cfg.update('teleportCluster', config.teleportCluster, true);
    await cfg.update('sftpHost', config.sftpHost, true);
    await cfg.update('sftpUser', config.sftpUser, true);
    await cfg.update('remotePath', config.remotePath, true);
    await cfg.update('localPath', config.localPath, true);
    await cfg.update('identity', config.identity, true);
    await cfg.update('debounceMs', config.debounceMs, true);
    await cfg.update('useTeleport', config.useTeleport, true);
    await cfg.update('rsyncFlags', config.rsyncFlags, true);
    await cfg.update('sshFlags', config.sshFlags, true);

    if (config.password !== undefined) {
        await context.secrets.store('sftpPluggin.password', config.password);
    }
}

export async function getPassword(context: vscode.ExtensionContext): Promise<string | undefined> {
    return context.secrets.get('sftpPluggin.password');
}
