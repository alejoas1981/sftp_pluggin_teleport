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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const config_1 = require("./config");
const sync_1 = require("./sync");
const watcher_1 = require("./watcher");
const status_1 = require("./status");
const progress_1 = require("./progress");
let outputChannel, extensionContext, syncInProgress = false;
const saveReasons = new Map();
/**
 * Activates the SFTP plugin and registers commands and event listeners.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
function activate(context) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('SFTP Plugin');
    context.subscriptions.push(outputChannel);
    (0, status_1.createStatusBar)(context);
    context.subscriptions.push(vscode.commands.registerCommand('sftpPluggin.openConfig', () => openConfigPanel(context)), vscode.commands.registerCommand('sftpPluggin.teleportLogin', () => runCommand(runTeleportLogin)), vscode.commands.registerCommand('sftpPluggin.syncNow', () => runCommand((cfg) => runSyncCommand(cfg, false))), vscode.commands.registerCommand('sftpPluggin.dryRun', () => runCommand((cfg) => runSyncCommand(cfg, true))), vscode.commands.registerCommand('sftpPluggin.testTeleport', () => runCommand(runConnectionTest)), vscode.commands.registerCommand('sftpPluggin.startWatching', () => runCommand((cfg) => startWatcher(context, cfg))), vscode.commands.registerCommand('sftpPluggin.stopWatching', stopWatcher), vscode.commands.registerCommand('sftpPluggin.uploadActiveFile', () => runCommand(uploadActiveFile)), vscode.commands.registerCommand('sftpPluggin.downloadActiveFile', () => runCommand(downloadActiveFile)), vscode.commands.registerCommand('sftpPluggin.syncFile', () => runCommand(syncActiveFile)), vscode.commands.registerCommand('sftpPluggin.deleteRemote', () => runCommand(deleteActiveFile)), vscode.workspace.onWillSaveTextDocument(handleDocumentWillSave), vscode.workspace.onDidSaveTextDocument(handleDocumentSave));
    autoLogin().catch((error) => {
        outputChannel.appendLine(`[auto-login] ${error.message}`);
        (0, status_1.updateSftpStatus)('$(warning) SFTP: not logged in');
    });
}
/**
 * Performs an automatic Teleport login on activation when enabled.
 * @returns {Promise<void>}
 */
async function autoLogin() {
    const config = await loadConfig();
    if ((0, config_1.resolveMode)(config) !== 'teleport' || !config.teleportHost) {
        (0, status_1.stopLoading)();
        return;
    }
    (0, status_1.startLoading)();
    await ensureTeleportIfNeeded(config);
    (0, status_1.stopLoading)();
}
/**
 * Loads the full configuration including the stored password.
 * @returns {Promise<SftpConfig>} The loaded configuration.
 */
async function loadConfig() {
    const base = (0, config_1.getConfiguration)(), password = await (0, config_1.getPassword)(extensionContext);
    return { ...base, password };
}
/**
 * Loads the configuration and runs the given action with error handling.
 * @param action - A function that receives the loaded configuration.
 * @returns {Promise<void>}
 */
async function runCommand(action) {
    const config = await loadConfig();
    try {
        await action(config);
    }
    catch (error) {
        outputChannel.appendLine(`[error] ${error.message}`);
        vscode.window.showErrorMessage(error.message);
    }
}
/**
 * Ensures a Teleport session is active when the mode is teleport.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function ensureTeleportIfNeeded(config) {
    if ((0, config_1.resolveMode)(config) === 'teleport') {
        await (0, sync_1.ensureTeleportSession)(config, { onLink: openTeleportLink });
    }
}
/**
 * Resolves the absolute local root path from the configuration.
 * @param config - The SFTP configuration.
 * @returns {string} The absolute local root path.
 */
function resolveLocalRoot(config) {
    if (!config.localPath) {
        throw new Error('localPath is not configured');
    }
    let root = config.localPath;
    if (!path.isAbsolute(root) && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        root = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, root);
    }
    return root;
}
/**
 * Validates the active file path and runs the given action with it.
 * @param config - The SFTP configuration.
 * @param action - A function that receives the local file path and returns a value.
 * @returns {Promise<[string, T]>} The local path and the action result.
 */
async function withActiveFile(config, action) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        throw new Error('No active file');
    }
    const localPath = editor.document.fileName;
    validateFileInLocalPath(config, localPath);
    await ensureTeleportIfNeeded(config);
    const result = await action(localPath);
    return [localPath, result];
}
/**
 * Runs a sync command, optionally in dry-run mode.
 * @param config - The SFTP configuration.
 * @param dryRun - Whether to perform a dry run.
 * @returns {Promise<void>}
 */
async function runSyncCommand(config, dryRun) {
    if (syncInProgress) {
        outputChannel.appendLine('SFTP sync already in progress');
        return;
    }
    if ((0, config_1.resolveMode)(config) === 'teleport' && (!config.teleportHost || !config.teleportUser)) {
        throw new Error('Teleport host and user are required');
    }
    syncInProgress = true;
    (0, status_1.startLoading)();
    try {
        await ensureTeleportIfNeeded(config);
        const mode = (0, config_1.resolveMode)(config);
        let result;
        if (mode === 'teleport') {
            result = await (0, sync_1.runSync)(config, { dryRun });
        }
        else {
            (0, status_1.stopLoading)();
            result = await (0, sync_1.runSync)(config, {
                dryRun,
                onProgress: (current, total, file, action) => {
                    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
                    (0, status_1.updateSftpStatus)(`$(sync) ${(0, progress_1.renderProgress)(percent)} ${action} ${path.basename(file)}`);
                },
            });
        }
        outputChannel.appendLine(result);
        (0, status_1.stopLoading)();
        outputChannel.appendLine(dryRun ? 'Dry run complete' : 'Sync complete');
    }
    catch (error) {
        (0, status_1.stopLoading)('$(error) SFTP: error');
        throw error;
    }
    finally {
        syncInProgress = false;
    }
}
/**
 * Uploads the active file to the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function uploadActiveFile(config) {
    (0, status_1.startLoading)();
    try {
        const [localPath] = await withActiveFile(config, (localPath) => (0, sync_1.uploadFile)(config, localPath));
        outputChannel.appendLine(`Uploaded ${localPath}`);
    }
    finally {
        (0, status_1.stopLoading)();
    }
}
/**
 * Downloads the active file from the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function downloadActiveFile(config) {
    (0, status_1.startLoading)();
    try {
        const [localPath] = await withActiveFile(config, (localPath) => (0, sync_1.downloadFile)(config, localPath));
        outputChannel.appendLine(`Downloaded ${localPath}`);
    }
    finally {
        (0, status_1.stopLoading)();
    }
}
/**
 * Deletes the active file from the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function deleteActiveFile(config) {
    const [localPath] = await withActiveFile(config, (localPath) => (0, sync_1.deleteRemoteFile)(config, localPath));
    outputChannel.appendLine(`Deleted remote ${localPath}`);
}
/**
 * Syncs the active file with the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function syncActiveFile(config) {
    const [localPath, result] = await withActiveFile(config, (localPath) => (0, sync_1.syncFile)(config, localPath));
    outputChannel.appendLine(`${result}: ${localPath}`);
}
/**
 * Validates that the given file is within the configured local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path to validate.
 * @returns {void}
 */
function validateFileInLocalPath(config, localPath) {
    if (!localPath.startsWith(resolveLocalRoot(config))) {
        throw new Error('Active file is outside the configured local path');
    }
}
/**
 * Tests the configured connection and logs the result.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function runConnectionTest(config) {
    (0, status_1.startLoading)();
    const result = await (0, sync_1.testConnection)(config);
    outputChannel.appendLine(result);
    (0, status_1.stopLoading)();
    outputChannel.appendLine('Connection test successful');
}
/**
 * Logs in to Teleport and logs the result.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function runTeleportLogin(config) {
    if ((0, config_1.resolveMode)(config) !== 'teleport' || !config.teleportHost || !config.teleportUser) {
        throw new Error('Teleport host and user are required');
    }
    (0, status_1.startLoading)();
    const result = await (0, sync_1.ensureTeleportSession)(config, { onLink: openTeleportLink });
    outputChannel.appendLine(result);
    (0, status_1.stopLoading)();
    outputChannel.appendLine('Teleport login successful');
}
/**
 * Starts the file watcher for the given workspace configuration.
 * @param context - The VS Code extension context.
 * @param config - The SFTP configuration.
 * @returns {void}
 */
function startWatcher(context, config) {
    /**
     * Triggers a sync while the watcher is active.
     * @returns {Promise<void>}
     */
    const doSync = async () => {
        if (syncInProgress) {
            return;
        }
        syncInProgress = true;
        (0, status_1.startLoading)();
        try {
            if ((0, config_1.resolveMode)(config) === 'teleport' && (!config.teleportHost || !config.teleportUser)) {
                throw new Error('Teleport host and user are required');
            }
            await ensureTeleportIfNeeded(config);
            const result = await (0, sync_1.runSync)(config);
            outputChannel.appendLine(result);
            (0, status_1.stopLoading)('$(eye) SFTP: watching');
        }
        catch (error) {
            (0, status_1.stopLoading)('$(error) SFTP: error');
            throw error;
        }
        finally {
            syncInProgress = false;
        }
    };
    (0, watcher_1.startWatching)(context, config, doSync, outputChannel);
    (0, status_1.stopLoading)('$(eye) SFTP: watching');
    outputChannel.appendLine('SFTP watcher started');
}
/**
 * Stops the file watcher and restores the status bar.
 * @returns {void}
 */
function stopWatcher() {
    (0, watcher_1.stopWatching)();
    (0, status_1.stopLoading)();
    outputChannel.appendLine('SFTP watcher stopped');
}
/**
 * Opens the SFTP configuration webview panel.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
function openConfigPanel(context) {
    const panel = vscode.window.createWebviewPanel('sftpConfig', 'FTP / SFTP / Teleport Configuration', vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview'))]
    });
    const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'config.html'), jsPath = path.join(context.extensionPath, 'src', 'webview', 'config.js'), jsContent = fs.readFileSync(jsPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/{{script}}/g, `<script type="text/javascript">\n${jsContent}\n</script>`);
    panel.webview.html = html;
    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined, settingsPath = workspaceFolder ? path.join(workspaceFolder, '.vscode', 'settings.json') : undefined;
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'ready': {
                const cfg = (0, config_1.getConfiguration)();
                if (workspaceFolder && !cfg.localPath) {
                    cfg.localPath = workspaceFolder;
                }
                const hasPassword = (await (0, config_1.getPassword)(context)) !== undefined, sectionConfig = vscode.workspace.getConfiguration('sftpPluggin'), modeInspect = sectionConfig.inspect('mode'), hasSavedConfig = modeInspect ? modeInspect.workspaceValue !== undefined : false;
                let isLoggedIn = false;
                if (cfg.mode === 'teleport' && cfg.teleportHost && cfg.teleportUser) {
                    isLoggedIn = await (0, sync_1.testConnection)(cfg).then(() => true).catch(() => false);
                }
                panel.webview.postMessage({ command: 'load', config: cfg, hasPassword, hasSavedConfig, isLoggedIn });
                break;
            }
            case 'save': {
                try {
                    await (0, config_1.saveConfiguration)(context, message.config);
                    panel.webview.postMessage({ command: 'saved', settingsPath });
                    outputChannel.appendLine('SFTP configuration saved');
                }
                catch (error) {
                    outputChannel.appendLine(`[save error] ${error.message}`);
                    panel.webview.postMessage({ command: 'error', detail: error.message });
                }
                break;
            }
            case 'login': {
                try {
                    const cfg = await loadConfig();
                    if (cfg.useTeleport === false || !cfg.teleportHost || !cfg.teleportUser) {
                        throw new Error('Teleport host and user are required');
                    }
                    (0, status_1.startLoading)();
                    const result = await (0, sync_1.ensureTeleportSession)(cfg, { onLink: openTeleportLink });
                    outputChannel.appendLine(result);
                    panel.webview.postMessage({ command: 'loginResult', status: 'ok', detail: 'Login successful' });
                    (0, status_1.stopLoading)();
                }
                catch (error) {
                    panel.webview.postMessage({ command: 'loginResult', status: 'error', detail: error.message });
                    (0, status_1.stopLoading)('$(error) SFTP: error');
                }
                break;
            }
            case 'test': {
                try {
                    const cfg = message.config;
                    if (!cfg.password) {
                        cfg.password = await (0, config_1.getPassword)(context);
                    }
                    (0, status_1.startLoading)();
                    const result = await (0, sync_1.testConnection)(cfg);
                    (0, status_1.stopLoading)();
                    panel.webview.postMessage({ command: 'testResult', status: 'ok', detail: result });
                }
                catch (error) {
                    (0, status_1.stopLoading)('$(error) SFTP: error');
                    panel.webview.postMessage({ command: 'testResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'sync': {
                try {
                    const cfg = await loadConfig();
                    if (syncInProgress) {
                        throw new Error('Sync already in progress');
                    }
                    await runSyncCommand(cfg, false);
                    panel.webview.postMessage({ command: 'syncResult', status: 'ok', detail: 'Sync complete' });
                }
                catch (error) {
                    panel.webview.postMessage({ command: 'syncResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'dryRun': {
                try {
                    const cfg = await loadConfig();
                    if (syncInProgress) {
                        throw new Error('Sync already in progress');
                    }
                    await runSyncCommand(cfg, true);
                    panel.webview.postMessage({ command: 'syncResult', status: 'ok', detail: 'Dry run complete' });
                }
                catch (error) {
                    panel.webview.postMessage({ command: 'syncResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'openFile': {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                    await vscode.window.showTextDocument(doc, { preview: false });
                }
                catch (error) {
                    outputChannel.appendLine(`[open file error] ${error.message}`);
                    vscode.window.showErrorMessage(error.message);
                }
                break;
            }
            case 'deleteConfig': {
                const mode = message.mode, modeLabel = mode ? mode.toUpperCase() : 'SFTP', choice = await vscode.window.showWarningMessage(`Delete ${modeLabel} configuration? This cannot be undone.`, { modal: true }, 'Delete');
                if (choice === 'Delete') {
                    await (0, config_1.deleteConfiguration)(context, mode);
                    panel.webview.postMessage({ command: 'deleted' });
                    outputChannel.appendLine(`${modeLabel} configuration deleted`);
                }
                break;
            }
        }
    });
}
/**
 * Opens the provided Teleport login URL in the default browser.
 * @param url - The URL to open.
 * @returns {void}
 */
function openTeleportLink(url) {
    vscode.env.openExternal(vscode.Uri.parse(url)).then((opened) => {
        if (opened) {
            return;
        }
        vscode.env.clipboard.writeText(url).then(() => {
            vscode.window.showInformationMessage(`Could not open browser. Link copied to clipboard. ${url}`, 'Open in browser').then((choice) => {
                if (choice === 'Open in browser') {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
            });
        });
    });
}
/**
 * Records the save reason for a document before it is saved.
 * @param event - The document will-save event.
 * @returns {void}
 */
function handleDocumentWillSave(event) {
    saveReasons.set(event.document.uri.toString(), event.reason);
}
/**
 * Triggers a sync when a saved document is within the configured local path.
 * @param doc - The saved text document.
 * @returns {void}
 */
function handleDocumentSave(doc) {
    if (doc.uri.scheme !== 'file') {
        return;
    }
    const uri = doc.uri.toString(), reason = saveReasons.get(uri);
    saveReasons.delete(uri);
    const settings = vscode.workspace.getConfiguration('sftpPluggin'), uploadOnSave = settings.get('uploadOnSave', true), uploadOnAutoSave = settings.get('uploadOnAutoSave', false);
    const isManual = reason === vscode.TextDocumentSaveReason.Manual, isAuto = reason === vscode.TextDocumentSaveReason.AfterDelay || reason === vscode.TextDocumentSaveReason.FocusOut;
    if (isManual && !uploadOnSave) {
        return;
    }
    if (isAuto && !uploadOnAutoSave) {
        return;
    }
    if (reason === undefined && !uploadOnSave) {
        return;
    }
    const config = (0, config_1.getConfiguration)();
    let localPath;
    try {
        localPath = resolveLocalRoot(config);
    }
    catch {
        return;
    }
    if (!doc.fileName.startsWith(localPath)) {
        return;
    }
    if (syncInProgress) {
        return;
    }
    (0, status_1.startLoading)();
    runCommand(async (cfg) => {
        if ((0, config_1.resolveMode)(cfg) === 'teleport') {
            await (0, sync_1.ensureTeleportSession)(cfg, { onLink: openTeleportLink });
        }
        await (0, sync_1.uploadFile)(cfg, doc.fileName);
        outputChannel.appendLine(`Uploaded ${doc.fileName}`);
    }).then(() => (0, status_1.stopLoading)(), () => (0, status_1.stopLoading)('$(error) SFTP: error'));
}
/**
 * Deactivates the plugin and stops any active watchers.
 * @returns {void}
 */
function deactivate() {
    (0, watcher_1.stopWatching)();
}
