import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfiguration, updateTransferButtonVisibility, initializeConfiguration, hasPrivateConfiguration, saveConfiguration, deleteConfiguration, getPassword, resolveMode, SftpConfig } from './config';
import { runSync, testConnection, ensureTeleportSession, uploadFile, downloadFile, deleteRemoteFile, syncFile, uploadChangedFiles, cancelActiveTransfer } from './sync';
import { startWatching, stopWatching } from './watcher';
import { createStatusBar, updateSftpStatus, startLoading, stopLoading } from './status';
import { renderProgress } from './progress';
import { SyncTask } from './sync-task';
import { normalizeRsyncOptions } from './rsync-options';
import { SaveUploadQueue } from './save-upload-queue';
import { PendingUploads } from './pending-uploads';
import { LocalChangeDiscovery } from './local-change-discovery';
import { isIgnored } from './utils';
import { SYNC_EXCLUDES } from './sync-state';
import { configureStorage } from './private-storage';

let outputChannel: vscode.OutputChannel, extensionContext: vscode.ExtensionContext, syncInProgress = false,
    saveUploads: SaveUploadQueue | undefined, savingBatch = false, pendingUploads: PendingUploads,
    configPanel: vscode.WebviewPanel | undefined, discovery: Promise<void> | undefined, discoveryController: AbortController;
const saveReasons = new Map<string, number>(), syncTask = new SyncTask();

/**
 * Activates the SFTP plugin and registers commands and event listeners.
 * @param context - The VS Code extension context.
 * @returns {Promise<void>} Resolves after initial local change discovery.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    discoveryController = new AbortController();
    extensionContext = context;
    pendingUploads = new PendingUploads(context.workspaceState);
    initializeConfiguration(context);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('sftpPluggin')) {
            updateTransferButtonVisibility();
        }
    }));
    configureStorage(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath));
    outputChannel = vscode.window.createOutputChannel('SFTP Plugin');
    context.subscriptions.push(outputChannel);

    createStatusBar(context);
    const unsubscribe = syncTask.subscribe((state) => {
        if (state.progressReset) {
            updateSftpStatus('$(cloud) SFTP: ready', 'Ready');
            return;
        }
        const icon = state.status === 'running' ? 'sync~spin' : state.status === 'error' ? 'error' : state.status === 'warning' ? 'warning' : 'check',
            progress = state.percent === undefined ? '' : renderProgress(state.percent) + ' ';
        updateSftpStatus(`$(${icon}) SFTP: ${progress}${state.phase}`, `${state.phase}\n${state.file}\nFiles: ${state.current}/${state.total ?? '?'} | Local: ${state.localFiles} | Remote: ${state.remoteFiles} | ${Math.floor(state.elapsedMs / 1000)}s`);
    });
    context.subscriptions.push({ dispose: () => { unsubscribe(); syncTask.dispose(); } });

    context.subscriptions.push(
        vscode.commands.registerCommand('sftpPluggin.openConfig', () => openConfigPanel(context)),
        vscode.commands.registerCommand('sftpPluggin.teleportLogin', () => runCommand(runTeleportLogin)),
        vscode.commands.registerCommand('sftpPluggin.syncNow', () => runCommand((cfg) => runSyncCommand(cfg, false))),
        vscode.commands.registerCommand('sftpPluggin.dryRun', () => runCommand((cfg) => runSyncCommand(cfg, true))),
        vscode.commands.registerCommand('sftpPluggin.testTeleport', () => runCommand(runConnectionTest)),
        vscode.commands.registerCommand('sftpPluggin.startWatching', () => runCommand((cfg) => startWatcher(context, cfg))),
        vscode.commands.registerCommand('sftpPluggin.stopWatching', stopWatcher),
        vscode.commands.registerCommand('sftpPluggin.cancelTransfer', cancelTransfer),
        vscode.commands.registerCommand('sftpPluggin.retryUploads', () => saveUploads?.request()),
        vscode.commands.registerCommand('sftpPluggin.uploadActiveFile', () => runCommand(uploadActiveFile)),
        vscode.commands.registerCommand('sftpPluggin.downloadActiveFile', () => runCommand(downloadActiveFile)),
        vscode.commands.registerCommand('sftpPluggin.syncFile', () => runCommand(syncActiveFile)),
        vscode.commands.registerCommand('sftpPluggin.deleteRemote', () => runCommand(deleteActiveFile)),
        vscode.workspace.onWillSaveTextDocument(handleDocumentWillSave),
        vscode.workspace.onDidSaveTextDocument(handleDocumentSave)
    );

    saveUploads = new SaveUploadQueue(uploadSavedChanges, () => syncInProgress,
        (error: any) => {
            outputChannel.appendLine(`[save upload error] ${error.message}`);
            updateSftpStatus('$(warning) SFTP upload paused', `${pendingUploads.entries(getConfiguration()).size} pending files. ${error.message}`);
            vscode.window.showErrorMessage(`SFTP upload paused with ${pendingUploads.entries(getConfiguration()).size} pending files. ${error.message}. Pending files retained. Use SFTP Retry Pending Uploads or save again.`);
        }, () => Math.max(50, getConfiguration().debounceMs ?? 300));
    const uploadWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false),
        onDiskChange = (uri: vscode.Uri) => {
            if (uri.scheme !== 'file' || !isUploadPath(getConfiguration(), uri.fsPath)) { return; }
            recordPendingUpload(uri.fsPath);
            if (!savingBatch) {
                const autoUpload = vscode.workspace.getConfiguration('sftpPluggin').get<boolean>('uploadOnAutoSave', false);
                if (autoUpload) { saveUploads?.request(); }
            }
        };
    uploadWatcher.onDidChange(onDiskChange);
    uploadWatcher.onDidCreate(onDiskChange);
    uploadWatcher.onDidDelete(onDiskChange);
    context.subscriptions.push(uploadWatcher, saveUploads, vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) { void discoverLocalUploads(); }
    }));
    if (pendingUploads.entries(getConfiguration()).size && vscode.workspace.getConfiguration('sftpPluggin').get<boolean>('uploadOnAutoSave', false)) {
        saveUploads.request();
    }

    const restoredCount = pendingUploads.entries(getConfiguration()).size;
    if (restoredCount) { updateSftpStatus('$(cloud-upload) SFTP pending', `${restoredCount} files waiting to upload`); }

    autoLogin().catch((error: any) => {
        outputChannel.appendLine(`[auto-login] ${error.message}`);
        updateSftpStatus('$(warning) SFTP: not logged in');
    });
    await discoverLocalUploads();
}

/** Discovers offline local edits once at a time and submits them to the durable queue.
 * @returns Completes after local discovery and pending path persistence.
 */
function discoverLocalUploads(): Promise<void> {
    if (discovery) { return discovery; }
    const config = getConfiguration(), mode = resolveMode(config), controller = discoveryController;
    if (!config.localPath || !path.isAbsolute(config.localPath) || !config.remotePath
        || (mode === 'ftp' ? !config.ftpHost || !config.ftpUser : !config.sftpHost || !config.sftpUser)
        || (mode === 'teleport' && (!config.teleportHost || !config.teleportUser))) { return Promise.resolve(); }
    const journal = pendingUploads;
    if (!syncInProgress) { updateSftpStatus('$(search) SFTP checking local changes'); }
    discovery = new LocalChangeDiscovery().scan(config, async (file) => {
        await journal.record(config, file);
    }, controller.signal).then((count) => {
        if (controller.signal.aborted) { return; }
        outputChannel.appendLine(`[local discovery] ${count} changed files found without a remote scan.`);
        if (!syncInProgress && !journal.entries(config).size) { stopLoading(); }
        if (count || journal.entries(config).size) {
            if (!syncInProgress) { updateSftpStatus('$(cloud-upload) SFTP pending', `${journal.entries(config).size} files waiting to upload`); }
            if (vscode.workspace.getConfiguration('sftpPluggin').get<boolean>('uploadOnAutoSave', false)) { saveUploads?.request(); }
        }
    }).catch((error: Error) => {
        if (controller.signal.aborted) { return; }
        outputChannel.appendLine(`[local discovery error] ${error.message}`);
        vscode.window.showErrorMessage(`Could not check offline local changes. ${error.message}`);
    }).finally(() => { discovery = undefined; });
    return discovery;
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
async function runCommand(action: (config: SftpConfig) => Promise<unknown> | void): Promise<void> {
    const config = await loadConfig();
    try {
        if (syncInProgress) { throw new Error('SFTP sync already in progress'); }
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
        await ensureTeleportSession(config, { onLink: openTeleportLink, onConfirmTrust: confirmTeleportTrust });
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
    if (syncInProgress) { throw new Error('SFTP sync already in progress'); }
    syncInProgress = true;
    try {
        await ensureTeleportIfNeeded(config);
        const result = await action(localPath);
        return [localPath, result];
    } finally { syncInProgress = false; }
}

/**
 * Runs a sync command, optionally in dry-run mode.
 * @param config - The SFTP configuration.
 * @param dryRun - Whether to perform a dry run.
 * @returns {Promise<void>}
 */
async function runSyncCommand(config: SftpConfig, dryRun: boolean): Promise<string> {
    if (syncInProgress) {
        throw new Error('SFTP sync already in progress');
    }
    if (resolveMode(config) === 'teleport' && (!config.teleportHost || !config.teleportUser)) {
        throw new Error('Teleport host and user are required');
    }
    syncInProgress = true;
    stopLoading();
    syncTask.start(dryRun);
    try {
        syncTask.log(`${dryRun ? 'DRY RUN' : 'SYNC'}: two-way (${resolveMode(config).toUpperCase()})\nConnecting…\n`);
        await ensureTeleportIfNeeded(config);
        const result = await runSync(config, {
            dryRun,
            onLog: (text) => { syncTask.log(text); outputChannel.appendLine(text.trimEnd()); },
            onState: (state) => syncTask.update(state),
        });
        outputChannel.appendLine(result);
        syncTask.finish(result);
        return result;
    } catch (error: any) {
        syncTask.finish(error.message, true);
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
    const result = await ensureTeleportSession(config, { onLink: openTeleportLink, onConfirmTrust: confirmTeleportTrust });
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
        await runSyncCommand(config, false);
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
    if (!syncInProgress) { stopLoading(); }
    outputChannel.appendLine('SFTP watcher stopped');
}

/** Cancels the active transfer while preserving queued paths for a later request. */
function cancelTransfer(): void {
    if (!cancelActiveTransfer()) {
        vscode.window.showInformationMessage('No active SFTP transfer');
        return;
    }
    outputChannel.appendLine('Cancelling active transfer…');
}

/**
 * Reveals the existing configuration tab or opens one when no panel exists.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
function openConfigPanel(context: vscode.ExtensionContext) {
    if (configPanel) { configPanel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
        'sftpConfig',
        'FTP / SFTP / Teleport Configuration',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview'))]
        }
    );

    configPanel = panel;
    context.subscriptions.push(panel);
    const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'config.html'),
        jsPath = path.join(context.extensionPath, 'src', 'webview', 'config.js'),
        jsContent = fs.readFileSync(jsPath, 'utf8');
    let html = fs.readFileSync(htmlPath, 'utf8');

    html = html.replace(/{{script}}/g, `<script type="text/javascript">\n${jsContent}\n</script>`);

    let disposed = false;
    const post = (message: unknown) => {
        if (disposed) { return; }
        try { Promise.resolve(panel.webview.postMessage(message)).catch(() => { /* Detached UI cannot fail a task. */ }); }
        catch { /* VS Code may throw synchronously after disposal. */ }
    },
        unsubscribe = syncTask.subscribe((state) => post({ command: 'syncState', state }));
    panel.onDidDispose(() => {
        disposed = true;
        if (configPanel === panel) { configPanel = undefined; }
        unsubscribe();
    });

    panel.webview.html = html;

    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;

    panel.webview.onDidReceiveMessage(async (message) => {
        if (syncInProgress && ['save', 'deleteConfig', 'login', 'test'].includes(message.command)) {
            post({ command: 'syncState', state: syncTask.snapshot() });
            return;
        }
        switch (message.command) {
            case 'getSyncState': {
                post({ command: 'syncState', state: syncTask.snapshot() });
                break;
            }
            case 'ready': {
                post({ command: 'syncState', state: syncTask.snapshot() });
                const cfg = getConfiguration();
                if (workspaceFolder && !cfg.localPath) { cfg.localPath = workspaceFolder; }
                const hasPassword = (await getPassword(context)) !== undefined,
                    sectionConfig = vscode.workspace.getConfiguration('sftpPluggin'),
                    modeInspect = sectionConfig.inspect('mode'),
                    hasSavedConfig = hasPrivateConfiguration() || (modeInspect ? modeInspect.workspaceValue !== undefined : false);
                let isLoggedIn = false;
                if (cfg.mode === 'teleport' && cfg.teleportHost && cfg.teleportUser) {
                    isLoggedIn = await testConnection(cfg).then(() => true).catch(() => false);
                }
                post({ command: 'load', config: cfg, hasPassword, hasSavedConfig, isLoggedIn });
                break;
            }
            case 'save': {
                try {
                    await saveConfiguration(context, message.config);
                    await discoverLocalUploads();
                    post({ command: 'saved' });
                    outputChannel.appendLine('SFTP configuration saved');
                } catch (error: any) {
                    outputChannel.appendLine(`[save error] ${error.message}`);
                    post({ command: 'error', detail: error.message });
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
                    const result = await ensureTeleportSession(cfg, { onLink: openTeleportLink, onConfirmTrust: confirmTeleportTrust });
                    outputChannel.appendLine(result);
                    post({ command: 'loginResult', status: 'ok', detail: 'Login successful' });
                    stopLoading();
                } catch (error: any) {
                    post({ command: 'loginResult', status: 'error', detail: error.message });
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
                    post({ command: 'testResult', status: 'ok', detail: result });
                } catch (error: any) {
                    stopLoading('$(error) SFTP: error');
                    post({ command: 'testResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'cancel': {
                const cancelled = cancelActiveTransfer();
                post({ command: 'cancelResult', status: cancelled ? 'warning' : 'error',
                    detail: cancelled ? 'Cancelling transfer…' : 'No active transfer' });
                break;
            }
            case 'sync':
            case 'dryRun': {
                try {
                    const cfg = await loadConfig();
                    await runSyncCommand(cfg, message.command === 'dryRun');
                } catch (error: any) {
                    post({ command: 'syncState', state: syncTask.snapshot() });
                    if (!syncInProgress && syncTask.snapshot()?.result !== error.message) {
                        post({ command: 'error', detail: error.message });
                    }
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
                    post({ command: 'deleted' });
                    outputChannel.appendLine(`${modeLabel} configuration deleted`);
                }
                break;
            }
        }
    });

}

/** Requests explicit trust confirmation for the certificate prompt emitted by tsh. */
async function confirmTeleportTrust(prompt: string): Promise<boolean> {
    return await vscode.window.showWarningMessage(`Teleport requests certificate trust confirmation.\n${prompt}`,
        { modal: true }, 'Trust certificate') === 'Trust certificate';
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

    if (isUploadPath(getConfiguration(), doc.fileName)) { recordPendingUpload(doc.fileName); }
    const settings = vscode.workspace.getConfiguration('sftpPluggin'),
        uploadOnSave = settings.get<boolean>('uploadOnSave', true),
        uploadOnAutoSave = settings.get<boolean>('uploadOnAutoSave', false);

    const isManual = reason === vscode.TextDocumentSaveReason.Manual,
        isAuto = reason === vscode.TextDocumentSaveReason.AfterDelay || reason === vscode.TextDocumentSaveReason.FocusOut;

    if (isManual && !uploadOnSave) { return; }
    if (isAuto && !uploadOnAutoSave) { return; }
    if (reason === undefined && !uploadOnSave) { return; }

    if (!savingBatch && isUploadPath(getConfiguration(), doc.fileName)) { saveUploads?.request(); }
}

/** Records external and editor changes without losing persistence errors. */
function recordPendingUpload(file: string): void {
    const config = getConfiguration();
    void pendingUploads.record(config, file).catch((error: Error) => {
        outputChannel.appendLine(`[pending uploads] ${error.message}`);
        vscode.window.showErrorMessage(`Cannot persist pending uploads. ${error.message}`);
    });
    if (!syncInProgress) { updateSftpStatus('$(cloud-upload) SFTP pending', `${pendingUploads.entries(config).size} files waiting to upload`); }
}

/** Tests whether a local path is eligible for upload under the current exclusions. */
function isUploadPath(config: SftpConfig, file: string): boolean {
    try {
        let exclusions = config.ignore ?? [];
        try { exclusions = normalizeRsyncOptions(config).ignore ?? []; }
        catch { /* Let the upload report invalid flags instead of silently ignoring saves. */ }
        const relative = path.relative(resolveLocalRoot(config), file).replace(/\\/g, '/');
        return !!relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)
            && !isIgnored(relative, [...exclusions, ...SYNC_EXCLUDES]);
    } catch { return false; }
}

/**
 * Uploads a queued snapshot while retaining newer versions for the next batch.
 * @returns {Promise<void>} Resolves after the current snapshot finishes or is superseded.
 */
async function uploadSavedChanges(): Promise<void> {
    const config = await loadConfig();
    if (syncInProgress) { saveUploads?.request(); return; }
    syncInProgress = true;
    syncTask.start(false);
    try {
        // Save only existing documents in this project; never prompt for untitled files.
        savingBatch = true;
        try {
            for (const document of vscode.workspace.textDocuments) {
                if (document.isDirty && document.uri.scheme === 'file' && isUploadPath(config, document.fileName)) {
                    if (!await document.save()) { throw new Error(`Could not save ${document.fileName}`); }
                }
            }
        } finally { savingBatch = false; }
        syncTask.log('UPLOAD: locally changed files only; no remote tree scan.\n');
        await pendingUploads.flush();
        await ensureTeleportIfNeeded(config);
        const batch = new Map([...pendingUploads.entries(config)].filter(([file]) => isUploadPath(config, file))),
            root = resolveLocalRoot(config),
            result = await uploadChangedFiles(config, {
            files: [...batch.keys()].map((file) => path.relative(root, file).replace(/\\/g, '/')),
            onLog: (text) => { syncTask.log(text); outputChannel.appendLine(text.trimEnd()); },
            onState: (state) => syncTask.update(state),
        });
        await pendingUploads.acknowledge(config, batch);
        const remaining = [...pendingUploads.entries(config).keys()].filter((file) => isUploadPath(config, file)).length;
        if (remaining) { saveUploads?.request(); }
        outputChannel.appendLine(`Pending uploads remaining ${remaining}`);
        outputChannel.appendLine(result);
        syncTask.finish(result);
    } catch (error: any) {
        syncTask.finish(error.message, true);
        throw error;
    } finally {
        syncInProgress = false;
    }
}

/**
 * Deactivates the plugin and stops any active watchers.
 * @returns {void}
 */
export function deactivate() {
    discoveryController?.abort();
    configPanel?.dispose();
    configPanel = undefined;
    saveUploads?.dispose();
    saveReasons.clear();
    syncTask.dispose();
    stopWatching();
}
