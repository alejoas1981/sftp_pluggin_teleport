import * as vscode from 'vscode';

export type ConnectionMode = 'ftp' | 'sftp' | 'teleport';

export interface SftpConfig {
    mode?: ConnectionMode;
    teleportHost?: string;
    teleportUser?: string;
    teleportCluster?: string;
    sftpHost?: string;
    sftpUser?: string;
    sftpPort?: number;
    ftpHost?: string;
    ftpUser?: string;
    ftpPort?: number;
    remotePath?: string;
    localPath?: string;
    identity?: string;
    password?: string;
    savePassword?: boolean;
    debounceMs?: number;
    useRsync?: boolean;
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

/**
 * Resolves the effective connection mode from the provided configuration.
 * @param config - Partial configuration with an optional mode and teleport flag.
 * @param config.mode - Optional explicit connection mode.
 * @param config.useTeleport - Optional flag to disable Teleport.
 * @returns {ConnectionMode} The resolved connection mode.
 */
export function resolveMode(config: { mode?: ConnectionMode; useTeleport?: boolean }): ConnectionMode {
    if (config.mode) { return config.mode; }
    return config.useTeleport === false ? 'sftp' : 'teleport';
}

/**
 * Loads the SFTP plugin configuration from VS Code settings.
 * @returns {SftpConfig} The resolved plugin configuration.
 */
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
    result.sftpPort = cfg.get<number>('sftpPort', 22) || 22;
    result.ftpPort = cfg.get<number>('ftpPort', 21) || 21;
    result.debounceMs = cfg.get<number>('debounceMs', 300);
    result.useRsync = cfg.get<boolean>('useRsync', false);
    result.useTeleport = cfg.get<boolean>('useTeleport', false);
    return result;
}

/**
 * Persists the provided configuration to VS Code settings and stores the password if requested.
 * @param context - The VS Code extension context.
 * @param config - The configuration to save.
 * @returns {Promise<void>}
 */
export async function saveConfiguration(
    context: vscode.ExtensionContext,
    config: SftpConfig
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(section),
        mode = resolveMode(config);

    await cfg.update('mode', mode, false);
    for (const key of stringKeys) {
        await cfg.update(key as string, (config as any)[key], false);
    }
    await cfg.update('sftpPort', config.sftpPort || 0, false);
    await cfg.update('ftpPort', config.ftpPort || 0, false);
    await cfg.update('debounceMs', config.debounceMs, false);
    await cfg.update('useRsync', config.useRsync ?? false, false);
    await cfg.update('useTeleport', mode === 'teleport', false);

    if (config.savePassword && config.password) {
        await context.secrets.store('sftpPluggin.password', config.password);
    }
}

const keysByMode: Record<ConnectionMode, string[]> = {
    ftp: ['mode', 'ftpHost', 'ftpUser', 'ftpPort', 'remotePath', 'localPath', 'debounceMs'],
    sftp: ['mode', 'sftpHost', 'sftpUser', 'sftpPort', 'useRsync', 'identity', 'sshFlags', 'remotePath', 'localPath', 'debounceMs'],
    teleport: ['mode', 'teleportHost', 'teleportUser', 'teleportCluster', 'sftpHost', 'sftpUser', 'sftpPort', 'useRsync', 'identity', 'sshFlags', 'rsyncFlags', 'useTeleport', 'remotePath', 'localPath', 'debounceMs']
};

/**
 * Removes all configuration keys associated with the given connection mode.
 * @param _context - The VS Code extension context (unused).
 * @param mode - The connection mode whose settings should be removed.
 * @returns {Promise<void>}
 */
export async function deleteConfiguration(
    _context: vscode.ExtensionContext,
    mode: ConnectionMode
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(section);
    const keys = keysByMode[mode] || [];
    for (const key of keys) {
        await cfg.update(key, undefined, false);
    }
}

/**
 * Retrieves the saved password from the extension secrets.
 * @param context - The VS Code extension context.
 * @returns {Promise<string | undefined>} The saved password, or undefined if not set.
 */
export async function getPassword(context: vscode.ExtensionContext): Promise<string | undefined> {
    return context.secrets.get('sftpPluggin.password');
}
