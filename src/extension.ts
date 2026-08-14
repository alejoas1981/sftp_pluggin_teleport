import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfiguration, saveConfiguration, getPassword, SftpConfig } from './config';
import { runSync, testTeleport, ensureTeleportSession } from './sync';
import { startWatching, stopWatching } from './watcher';
import { createStatusBar, updateSftpStatus } from './status';

let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;
let syncInProgress = false;
const saveReasons = new Map<string, number>();

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
        vscode.commands.registerCommand('sftpPluggin.testTeleport', () => runCommand(runTeleportTest)),
        vscode.commands.registerCommand('sftpPluggin.startWatching', () => runCommand((cfg) => startWatcher(context, cfg))),
        vscode.commands.registerCommand('sftpPluggin.stopWatching', stopWatcher),
        vscode.workspace.onWillSaveTextDocument(handleDocumentWillSave),
        vscode.workspace.onDidSaveTextDocument(handleDocumentSave)
    );

    autoLogin().catch((error: any) => {
        outputChannel.appendLine(`[auto-login] ${error.message}`);
        updateSftpStatus('$(warning) SFTP: not logged in');
    });
}

async function autoLogin(): Promise<void> {
    const config = await loadConfig();
    if (config.useTeleport === false || !config.teleportHost) {
        updateSftpStatus('$(check) SFTP: ready');
        return;
    }
    updateSftpStatus('$(sync) SFTP: checking Teleport...');
    await ensureTeleportSession(config, { onLink: openTeleportLink });
    updateSftpStatus('$(check) SFTP: ready');
}

async function loadConfig(): Promise<SftpConfig> {
    const base = getConfiguration();
    const password = await getPassword(extensionContext);
    return { ...base, password } as SftpConfig;
}

async function runCommand(action: (config: SftpConfig) => Promise<void> | void): Promise<void> {
    const config = await loadConfig();
    try {
        await action(config);
    } catch (error: any) {
        outputChannel.appendLine(`[error] ${error.message}`);
        vscode.window.showErrorMessage(error.message);
    }
}

async function runSyncCommand(config: SftpConfig, dryRun: boolean): Promise<void> {
    if (syncInProgress) {
        outputChannel.appendLine('SFTP sync already in progress');
        return;
    }
    if (config.useTeleport !== false) {
        if (!config.teleportHost || !config.teleportUser) {
            throw new Error('Teleport host and user are required');
        }
    }
    syncInProgress = true;
    updateSftpStatus('$(sync) SFTP: logging in...');
    try {
        if (config.useTeleport !== false) {
            await ensureTeleportSession(config, { onLink: openTeleportLink });
        }
        updateSftpStatus(`$(sync) SFTP: ${dryRun ? 'dry-run' : 'syncing'}...`);
        const result = await runSync(config, { dryRun });
        outputChannel.appendLine(result);
        updateSftpStatus('$(check) SFTP: ready');
        outputChannel.appendLine(dryRun ? 'Dry run complete' : 'Sync complete');
    } catch (error: any) {
        updateSftpStatus('$(error) SFTP: error');
        throw error;
    } finally {
        syncInProgress = false;
    }
}

async function runTeleportTest(config: SftpConfig): Promise<void> {
    updateSftpStatus('$(sync) SFTP: checking...');
    const result = await testTeleport(config);
    outputChannel.appendLine(result);
    updateSftpStatus('$(check) SFTP: ready');
    outputChannel.appendLine('Teleport session is active');
}

async function runTeleportLogin(config: SftpConfig): Promise<void> {
    if (config.useTeleport === false || !config.teleportHost || !config.teleportUser) {
        throw new Error('Teleport host and user are required');
    }
    updateSftpStatus('$(sync) SFTP: logging in...');
    const result = await ensureTeleportSession(config, { onLink: openTeleportLink });
    outputChannel.appendLine(result);
    updateSftpStatus('$(check) SFTP: ready');
    outputChannel.appendLine('Teleport login successful');
}

function startWatcher(context: vscode.ExtensionContext, config: SftpConfig): void {
    const doSync = async (): Promise<void> => {
        if (syncInProgress) { return; }
        syncInProgress = true;
        updateSftpStatus('$(sync) SFTP: syncing...');
        try {
            if (config.useTeleport !== false) {
                if (!config.teleportHost || !config.teleportUser) {
                    throw new Error('Teleport host and user are required');
                }
                await ensureTeleportSession(config, { onLink: openTeleportLink });
            }
            const result = await runSync(config);
            outputChannel.appendLine(result);
            updateSftpStatus('$(eye) SFTP: watching');
        } catch (error: any) {
            updateSftpStatus('$(error) SFTP: error');
            throw error;
        } finally {
            syncInProgress = false;
        }
    };

    startWatching(context, config, doSync, outputChannel);
    updateSftpStatus('$(eye) SFTP: watching');
    outputChannel.appendLine('SFTP watcher started');
}

function stopWatcher(): void {
    stopWatching();
    updateSftpStatus('$(check) SFTP: ready');
    outputChannel.appendLine('SFTP watcher stopped');
}

function openConfigPanel(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'sftpConfig',
        'SFTP Configuration',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview'))]
        }
    );

    const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'config.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const scriptUri = panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'config.js'))
    ).toString();

    html = html.replace(/{{scriptUri}}/g, scriptUri);

    panel.webview.html = html;

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'ready':
                panel.webview.postMessage({ command: 'load', config: getConfiguration() });
                break;
            case 'save':
                await saveConfiguration(context, message.config);
                panel.webview.postMessage({ command: 'saved' });
                outputChannel.appendLine('SFTP configuration saved');
                break;
            case 'login': {
                try {
                    const cfg = await loadConfig();
                    if (cfg.useTeleport === false || !cfg.teleportHost || !cfg.teleportUser) {
                        throw new Error('Teleport host and user are required');
                    }
                    updateSftpStatus('$(sync) SFTP: logging in...');
                    const result = await ensureTeleportSession(cfg, { onLink: openTeleportLink });
                    outputChannel.appendLine(result);
                    panel.webview.postMessage({ command: 'loginResult', status: 'ok', detail: 'Login successful' });
                    updateSftpStatus('$(check) SFTP: ready');
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'loginResult', status: 'error', detail: error.message });
                    updateSftpStatus('$(error) SFTP: error');
                }
                break;
            }
            case 'test': {
                try {
                    const cfg = await loadConfig();
                    updateSftpStatus('$(sync) SFTP: checking...');
                    const result = await testTeleport(cfg);
                    updateSftpStatus('$(check) SFTP: ready');
                    panel.webview.postMessage({ command: 'testResult', status: 'ok', detail: result });
                } catch (error: any) {
                    updateSftpStatus('$(error) SFTP: error');
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
        }
    });

}

function openTeleportLink(url: string): void {
    vscode.env.openExternal(vscode.Uri.parse(url));
    vscode.window.showInformationMessage(`Open Teleport login: ${url}`, 'Open in browser').then((choice) => {
        if (choice === 'Open in browser') {
            vscode.env.openExternal(vscode.Uri.parse(url));
        }
    });
}

function handleDocumentWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    saveReasons.set(event.document.uri.toString(), event.reason);
}

function handleDocumentSave(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') { return; }
    const uri = doc.uri.toString();
    const reason = saveReasons.get(uri);
    saveReasons.delete(uri);

    const settings = vscode.workspace.getConfiguration('sftpPluggin');
    const uploadOnSave = settings.get<boolean>('uploadOnSave', true);
    const uploadOnAutoSave = settings.get<boolean>('uploadOnAutoSave', false);

    const isManual = reason === vscode.TextDocumentSaveReason.Manual;
    const isAuto = reason === vscode.TextDocumentSaveReason.AfterDelay || reason === vscode.TextDocumentSaveReason.FocusOut;

    if (isManual && !uploadOnSave) { return; }
    if (isAuto && !uploadOnAutoSave) { return; }
    if (reason === undefined && !uploadOnSave) { return; }

    const config = getConfiguration();
    if (!config.localPath) { return; }
    let localPath = config.localPath;
    if (!path.isAbsolute(localPath) && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        localPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, localPath);
    }
    if (!doc.fileName.startsWith(localPath)) { return; }
    if (syncInProgress) { return; }
    vscode.commands.executeCommand('sftpPluggin.syncNow');
}

export function deactivate() {
    stopWatching();
}
