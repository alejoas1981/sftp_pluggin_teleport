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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMode = resolveMode;
exports.getConfiguration = getConfiguration;
exports.saveConfiguration = saveConfiguration;
exports.deleteConfiguration = deleteConfiguration;
exports.getPassword = getPassword;
const vscode = __importStar(require("vscode"));
const section = 'sftpPluggin';
const scalarSettings = [
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
function resolveMode(config) {
    if (config.mode) {
        return config.mode;
    }
    return config.useTeleport === false ? 'sftp' : 'teleport';
}
/**
 * Loads the SFTP plugin configuration from VS Code settings.
 * @returns {SftpConfig} The resolved plugin configuration.
 */
function getConfiguration() {
    const cfg = vscode.workspace.getConfiguration(section), mode = resolveMode({
        mode: cfg.get('mode'),
        useTeleport: cfg.get('useTeleport')
    }), result = { mode };
    for (const { key, loadDefault } of scalarSettings) {
        result[key] = cfg.get(key, loadDefault);
    }
    return result;
}
/**
 * Persists the provided configuration to VS Code settings and stores the password if requested.
 * @param context - The VS Code extension context.
 * @param config - The configuration to save.
 * @returns {Promise<void>}
 */
async function saveConfiguration(context, config) {
    const cfg = vscode.workspace.getConfiguration(section), mode = resolveMode(config);
    await cfg.update('mode', mode, false);
    for (const { key, saveValue } of scalarSettings) {
        if (key === 'useTeleport') {
            continue;
        }
        const raw = config[key];
        await cfg.update(key, saveValue ? saveValue(raw) : raw, false);
    }
    await cfg.update('useTeleport', mode === 'teleport', false);
    if (config.savePassword && config.password) {
        await context.secrets.store('sftpPluggin.password', config.password);
    }
}
const keysByMode = {
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
async function deleteConfiguration(_context, mode) {
    const cfg = vscode.workspace.getConfiguration(section), keys = keysByMode[mode] || [];
    for (const key of keys) {
        await cfg.update(key, undefined, false);
    }
}
/**
 * Retrieves the saved password from the extension secrets.
 * @param context - The VS Code extension context.
 * @returns {Promise<string | undefined>} The saved password, or undefined if not set.
 */
async function getPassword(context) {
    return context.secrets.get('sftpPluggin.password');
}
