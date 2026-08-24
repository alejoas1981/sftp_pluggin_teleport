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
    privateKey?: string;
    passphrase?: string;
    agent?: string;
    password?: string;
    savePassword?: boolean;
    debounceMs?: number;
    useRsync?: boolean;
    useTeleport?: boolean;
    rsyncFlags?: string;
    sshFlags?: string;
    ignore?: string[];
    concurrency?: number;
    ftpPassive?: boolean;
    ftpSecure?: boolean;
    showUploadButton?: boolean;
    showDownloadButton?: boolean;
}

const section = 'sftpPluggin';

const scalarSettings: { key: keyof SftpConfig; loadDefault?: any; saveValue?: (v: any) => any }[] = [
    { key: 'teleportHost' },
    { key: 'teleportUser' },
    { key: 'teleportCluster' },
    { key: 'sftpHost' },
    { key: 'sftpUser' },
    { key: 'sftpPort', loadDefault: 22, saveValue: (v) => v || 0 },
    { key: 'ftpHost' },
    { key: 'ftpUser' },
    { key: 'ftpPort', loadDefault: 21, saveValue: (v) => v || 0 },
    { key: 'remotePath' },
    { key: 'localPath' },
    { key: 'identity' },
    { key: 'privateKey' },
    { key: 'passphrase' },
    { key: 'agent' },
    { key: 'rsyncFlags' },
    { key: 'sshFlags' },
    { key: 'debounceMs', loadDefault: 300 },
    { key: 'useRsync', loadDefault: false, saveValue: (v) => v ?? false },
    { key: 'useTeleport', loadDefault: false },
    { key: 'ftpPassive', loadDefault: true, saveValue: (v) => v ?? true },
    { key: 'ftpSecure', loadDefault: false, saveValue: (v) => v ?? false },
    { key: 'showUploadButton', loadDefault: false, saveValue: (v) => v ?? false },
    { key: 'showDownloadButton', loadDefault: false, saveValue: (v) => v ?? false },
    { key: 'ignore', loadDefault: [], saveValue: (v) => v ?? [] },
    { key: 'concurrency', loadDefault: 4, saveValue: (v) => v ?? 4 },
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
    const cfg = vscode.workspace.getConfiguration(section),
        mode = resolveMode({
            mode: cfg.get<ConnectionMode>('mode'),
            useTeleport: cfg.get<boolean>('useTeleport')
        }),
        result: SftpConfig = { mode };
    for (const { key, loadDefault } of scalarSettings) {
        (result as any)[key] = cfg.get(key as string, loadDefault);
    }
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
    for (const { key, saveValue } of scalarSettings) {
        if (key === 'useTeleport') { continue; }
        const raw = (config as any)[key];
        await cfg.update(key as string, saveValue ? saveValue(raw) : raw, false);
    }
    await cfg.update('useTeleport', mode === 'teleport', false);

    if (config.savePassword && config.password) {
        await context.secrets.store('sftpPluggin.password', config.password);
    }
}

const keysByMode: Record<ConnectionMode, string[]> = {
    ftp: ['mode', 'ftpHost', 'ftpUser', 'ftpPort', 'ftpPassive', 'ftpSecure', 'remotePath', 'localPath', 'debounceMs', 'concurrency', 'ignore'],
    sftp: ['mode', 'sftpHost', 'sftpUser', 'sftpPort', 'useRsync', 'identity', 'privateKey', 'passphrase', 'agent', 'sshFlags', 'remotePath', 'localPath', 'debounceMs', 'concurrency', 'ignore'],
    teleport: ['mode', 'teleportHost', 'teleportUser', 'teleportCluster', 'sftpHost', 'sftpUser', 'sftpPort', 'useRsync', 'identity', 'privateKey', 'passphrase', 'agent', 'sshFlags', 'rsyncFlags', 'useTeleport', 'remotePath', 'localPath', 'debounceMs', 'concurrency', 'ignore']
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
    const cfg = vscode.workspace.getConfiguration(section),
        keys = keysByMode[mode] || [];
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
