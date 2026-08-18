import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfiguration, saveConfiguration, deleteConfiguration, getPassword, resolveMode, SftpConfig } from './config';
import { runSync, testConnection, ensureTeleportSession, uploadFile, downloadFile, deleteRemoteFile, syncFile } from './sync';
import { startWatching, stopWatching } from './watcher';
import { createStatusBar, updateSftpStatus, startLoading, stopLoading } from './status';
import { renderProgress } from './progress';

let outputChannel: vscode.OutputChannel, extensionContext: vscode.ExtensionContext, syncInProgress = false;
const saveReasons = new Map<string, number>();

/**
 * Activates the SFTP plugin and registers commands and event listeners.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('SFTP Plugin');
    context.subscriptions.push(outputChannel);

    createStatusBar(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('sftpPluggin.openConfig', () => openConfigPanel(context)),
        vscode.commands.registerCommand('sftpPluggin.teleportLogin', () => runCommand(runTeleportLogin)),
        vscode.commands.registerCommand('sftpPluggin.syncNow', () => runCommand((cfg) => runSyncCommand(cfg, false))),
        vscode.commands.registerCommand('sftpPluggin.dryRun', () => runCommand((cfg) => runSyncCommand(cfg, true))),
        vscode.commands.registerCommand('sftpPluggin.testTeleport', () => runCommand(runConnectionTest)),
        vscode.commands.registerCommand('sftpPluggin.startWatching', () => runCommand((cfg) => startWatcher(context, cfg))),
        vscode.commands.registerCommand('sftpPluggin.stopWatching', stopWatcher),
        vscode.commands.registerCommand('sftpPluggin.uploadActiveFile', () => runCommand(uploadActiveFile)),
        vscode.commands.registerCommand('sftpPluggin.downloadActiveFile', () => runCommand(downloadActiveFile)),
        vscode.commands.registerCommand('sftpPluggin.syncFile', () => runCommand(syncActiveFile)),
        vscode.commands.registerCommand('sftpPluggin.deleteRemote', () => runCommand(deleteActiveFile)),
        vscode.workspace.onWillSaveTextDocument(handleDocumentWillSave),
        vscode.workspace.onDidSaveTextDocument(handleDocumentSave)
    );

    autoLogin().catch((error: any) => {
        outputChannel.appendLine(`[auto-login] ${error.message}`);
        updateSftpStatus('$(warning) SFTP: not logged in');
    });
}

/**
 * Performs an automatic Teleport login on activation when enabled.
 * @returns {Promise<void>}
 */
async function autoLogin(): Promise<void> {
    const config = await loadConfig();
    if (resolveMode(config) !== 'teleport' || !config.teleportHost) {
        stopLoading();
        return;
    }
    startLoading();
    await ensureTeleportIfNeeded(config);
    stopLoading();
}

/**
 * Loads the full configuration including the stored password.
 * @returns {Promise<SftpConfig>} The loaded configuration.
 */
async function loadConfig(): Promise<SftpConfig> {
    const base = getConfiguration(), password = await getPassword(extensionContext);
    return { ...base, password } as SftpConfig;
}

/**
 * Loads the configuration and runs the given action with error handling.
 * @param action - A function that receives the loaded configuration.
 * @returns {Promise<void>}
 */
async function runCommand(action: (config: SftpConfig) => Promise<void> | void): Promise<void> {
    const config = await loadConfig();
    try {
        await action(config);
    } catch (error: any) {
        outputChannel.appendLine(`[error] ${error.message}`);
        vscode.window.showErrorMessage(error.message);
    }
}

/**
 * Ensures a Teleport session is active when the mode is teleport.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function ensureTeleportIfNeeded(config: SftpConfig): Promise<void> {
    if (resolveMode(config) === 'teleport') {
        await ensureTeleportSession(config, { onLink: openTeleportLink });
    }
}

/**
 * Resolves the absolute local root path from the configuration.
 * @param config - The SFTP configuration.
 * @returns {string} The absolute local root path.
 */
function resolveLocalRoot(config: SftpConfig): string {
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
async function withActiveFile<T>(config: SftpConfig, action: (localPath: string) => Promise<T>): Promise<[string, T]> {
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
async function runSyncCommand(config: SftpConfig, dryRun: boolean): Promise<void> {
    if (syncInProgress) {
        outputChannel.appendLine('SFTP sync already in progress');
        return;
    }
    if (resolveMode(config) === 'teleport' && (!config.teleportHost || !config.teleportUser)) {
        throw new Error('Teleport host and user are required');
    }
    syncInProgress = true;
    startLoading();
    try {
        await ensureTeleportIfNeeded(config);
        const mode = resolveMode(config);
        let result: string;
        if (mode === 'teleport') {
            result = await runSync(config, { dryRun });
        } else {
            stopLoading();
            result = await runSync(config, {
                dryRun,
                onProgress: (current, total, file, action) => {
                    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
                    updateSftpStatus(`$(sync) ${renderProgress(percent)} ${action} ${path.basename(file)}`);
                },
            });
        }
        outputChannel.appendLine(result);
        stopLoading();
        outputChannel.appendLine(dryRun ? 'Dry run complete' : 'Sync complete');
    } catch (error: any) {
        stopLoading('$(error) SFTP: error');
        throw error;
    } finally {
        syncInProgress = false;
    }
}

/**
 * Uploads the active file to the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function uploadActiveFile(config: SftpConfig): Promise<void> {
    startLoading();
    try {
        const [localPath] = await withActiveFile(config, (localPath) => uploadFile(config, localPath));
        outputChannel.appendLine(`Uploaded ${localPath}`);
    } finally {
        stopLoading();
    }
}

/**
 * Downloads the active file from the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function downloadActiveFile(config: SftpConfig): Promise<void> {
    startLoading();
    try {
        const [localPath] = await withActiveFile(config, (localPath) => downloadFile(config, localPath));
        outputChannel.appendLine(`Downloaded ${localPath}`);
    } finally {
        stopLoading();
    }
}

/**
 * Deletes the active file from the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function deleteActiveFile(config: SftpConfig): Promise<void> {
    const [localPath] = await withActiveFile(config, (localPath) => deleteRemoteFile(config, localPath));
    outputChannel.appendLine(`Deleted remote ${localPath}`);
}

/**
 * Syncs the active file with the remote server.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function syncActiveFile(config: SftpConfig): Promise<void> {
    const [localPath, result] = await withActiveFile(config, (localPath) => syncFile(config, localPath));
    outputChannel.appendLine(`${result}: ${localPath}`);
}

/**
 * Validates that the given file is within the configured local path.
 * @param config - The SFTP configuration.
 * @param localPath - The local file path to validate.
 * @returns {void}
 */
function validateFileInLocalPath(config: SftpConfig, localPath: string): void {
    if (!localPath.startsWith(resolveLocalRoot(config))) {
        throw new Error('Active file is outside the configured local path');
    }
}

/**
 * Tests the configured connection and logs the result.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function runConnectionTest(config: SftpConfig): Promise<void> {
    startLoading();
    const result = await testConnection(config);
    outputChannel.appendLine(result);
    stopLoading();
    outputChannel.appendLine('Connection test successful');
}

/**
 * Logs in to Teleport and logs the result.
 * @param config - The SFTP configuration.
 * @returns {Promise<void>}
 */
async function runTeleportLogin(config: SftpConfig): Promise<void> {
    if (resolveMode(config) !== 'teleport' || !config.teleportHost || !config.teleportUser) {
        throw new Error('Teleport host and user are required');
    }
    startLoading();
    const result = await ensureTeleportSession(config, { onLink: openTeleportLink });
    outputChannel.appendLine(result);
    stopLoading();
    outputChannel.appendLine('Teleport login successful');
}

/**
 * Starts the file watcher for the given workspace configuration.
 * @param context - The VS Code extension context.
 * @param config - The SFTP configuration.
 * @returns {void}
 */
function startWatcher(context: vscode.ExtensionContext, config: SftpConfig): void {
    /**
     * Triggers a sync while the watcher is active.
     * @returns {Promise<void>}
     */
    const doSync = async (): Promise<void> => {
        if (syncInProgress) { return; }
        syncInProgress = true;
        startLoading();
        try {
            if (resolveMode(config) === 'teleport' && (!config.teleportHost || !config.teleportUser)) {
                throw new Error('Teleport host and user are required');
            }
            await ensureTeleportIfNeeded(config);
            const result = await runSync(config);
            outputChannel.appendLine(result);
            stopLoading('$(eye) SFTP: watching');
        } catch (error: any) {
            stopLoading('$(error) SFTP: error');
            throw error;
        } finally {
            syncInProgress = false;
        }
    };

    startWatching(context, config, doSync, outputChannel);
    stopLoading('$(eye) SFTP: watching');
    outputChannel.appendLine('SFTP watcher started');
}

/**
 * Stops the file watcher and restores the status bar.
 * @returns {void}
 */
function stopWatcher(): void {
    stopWatching();
    stopLoading();
    outputChannel.appendLine('SFTP watcher stopped');
}

/**
 * Opens the SFTP configuration webview panel.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
function openConfigPanel(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'sftpConfig',
        'FTP / SFTP / Teleport Configuration',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview'))]
        }
    );

    const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'config.html'),
        jsPath = path.join(context.extensionPath, 'src', 'webview', 'config.js'),
        jsContent = fs.readFileSync(jsPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    html = html.replace(/{{script}}/g, `<script type="text/javascript">\n${jsContent}\n</script>`);

    panel.webview.html = html;

    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined,
        settingsPath = workspaceFolder ? path.join(workspaceFolder, '.vscode', 'settings.json') : undefined;

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'ready': {
                const cfg = getConfiguration();
                if (workspaceFolder && !cfg.localPath) { cfg.localPath = workspaceFolder; }
                const hasPassword = (await getPassword(context)) !== undefined,
                    sectionConfig = vscode.workspace.getConfiguration('sftpPluggin'),
                    modeInspect = sectionConfig.inspect('mode'),
                    hasSavedConfig = modeInspect ? modeInspect.workspaceValue !== undefined : false;
                let isLoggedIn = false;
                if (cfg.mode === 'teleport' && cfg.teleportHost && cfg.teleportUser) {
                    isLoggedIn = await testConnection(cfg).then(() => true).catch(() => false);
                }
                panel.webview.postMessage({ command: 'load', config: cfg, hasPassword, hasSavedConfig, isLoggedIn });
                break;
            }
            case 'save': {
                try {
                    await saveConfiguration(context, message.config);
                    panel.webview.postMessage({ command: 'saved', settingsPath });
                    outputChannel.appendLine('SFTP configuration saved');
                } catch (error: any) {
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
                    startLoading();
                    const result = await ensureTeleportSession(cfg, { onLink: openTeleportLink });
                    outputChannel.appendLine(result);
                    panel.webview.postMessage({ command: 'loginResult', status: 'ok', detail: 'Login successful' });
                    stopLoading();
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'loginResult', status: 'error', detail: error.message });
                    stopLoading('$(error) SFTP: error');
                }
                break;
            }
            case 'test': {
                try {
                    const cfg = message.config as SftpConfig;
                    if (!cfg.password) { cfg.password = await getPassword(context); }
                    startLoading();
                    const result = await testConnection(cfg);
                    stopLoading();
                    panel.webview.postMessage({ command: 'testResult', status: 'ok', detail: result });
                } catch (error: any) {
                    stopLoading('$(error) SFTP: error');
                    panel.webview.postMessage({ command: 'testResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'sync': {
                try {
                    const cfg = await loadConfig();
                    if (syncInProgress) { throw new Error('Sync already in progress'); }
                    await runSyncCommand(cfg, false);
                    panel.webview.postMessage({ command: 'syncResult', status: 'ok', detail: 'Sync complete' });
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'syncResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'dryRun': {
                try {
                    const cfg = await loadConfig();
                    if (syncInProgress) { throw new Error('Sync already in progress'); }
                    await runSyncCommand(cfg, true);
                    panel.webview.postMessage({ command: 'syncResult', status: 'ok', detail: 'Dry run complete' });
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'syncResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'openFile': {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                    await vscode.window.showTextDocument(doc, { preview: false });
                } catch (error: any) {
                    outputChannel.appendLine(`[open file error] ${error.message}`);
                    vscode.window.showErrorMessage(error.message);
                }
                break;
            }
            case 'deleteConfig': {
                const mode = message.mode as string,
                    modeLabel = mode ? mode.toUpperCase() : 'SFTP',
                    choice = await vscode.window.showWarningMessage(
                        `Delete ${modeLabel} configuration? This cannot be undone.`,
                        { modal: true },
                        'Delete'
                    );
                if (choice === 'Delete') {
                    await deleteConfiguration(context, mode as any);
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
function openTeleportLink(url: string): void {
    vscode.env.openExternal(vscode.Uri.parse(url)).then((opened) => {
        if (opened) { return; }
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
function handleDocumentWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    saveReasons.set(event.document.uri.toString(), event.reason);
}

/**
 * Triggers a sync when a saved document is within the configured local path.
 * @param doc - The saved text document.
 * @returns {void}
 */
function handleDocumentSave(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') { return; }
    const uri = doc.uri.toString(),
        reason = saveReasons.get(uri);
    saveReasons.delete(uri);

    const settings = vscode.workspace.getConfiguration('sftpPluggin'),
        uploadOnSave = settings.get<boolean>('uploadOnSave', true),
        uploadOnAutoSave = settings.get<boolean>('uploadOnAutoSave', false);

    const isManual = reason === vscode.TextDocumentSaveReason.Manual,
        isAuto = reason === vscode.TextDocumentSaveReason.AfterDelay || reason === vscode.TextDocumentSaveReason.FocusOut;

    if (isManual && !uploadOnSave) { return; }
    if (isAuto && !uploadOnAutoSave) { return; }
    if (reason === undefined && !uploadOnSave) { return; }

    const config = getConfiguration();
    let localPath: string;
    try {
        localPath = resolveLocalRoot(config);
    } catch {
        return;
    }
    if (!doc.fileName.startsWith(localPath)) { return; }
    if (syncInProgress) { return; }
    startLoading();
    runCommand(async (cfg) => {
        if (resolveMode(cfg) === 'teleport') {
            await ensureTeleportSession(cfg, { onLink: openTeleportLink });
        }
        await uploadFile(cfg, doc.fileName);
        outputChannel.appendLine(`Uploaded ${doc.fileName}`);
    }).then(() => stopLoading(), () => stopLoading('$(error) SFTP: error'));
}

/**
 * Deactivates the plugin and stops any active watchers.
 * @returns {void}
 */
export function deactivate() {
    stopWatching();
}
