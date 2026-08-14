import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfiguration, saveConfiguration, getPassword, SftpConfig } from './config';
import { runSync, testTeleport } from './sync';
import { startWatching, stopWatching } from './watcher';

let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('SFTP Plugin');
    context.subscriptions.push(outputChannel);

    context.subscriptions.push(
        vscode.commands.registerCommand('sftpPluggin.openConfig', () => openConfigPanel(context)),
        vscode.commands.registerCommand('sftpPluggin.syncNow', () => runCommand((cfg) => runSyncCommand(cfg, false))),
        vscode.commands.registerCommand('sftpPluggin.dryRun', () => runCommand((cfg) => runSyncCommand(cfg, true))),
        vscode.commands.registerCommand('sftpPluggin.testTeleport', () => runCommand(runTeleportTest)),
        vscode.commands.registerCommand('sftpPluggin.startWatching', () => runCommand((cfg) => startWatcher(context, cfg))),
        vscode.commands.registerCommand('sftpPluggin.stopWatching', stopWatcher)
    );
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
    outputChannel.appendLine(`[sync] ${dryRun ? 'dry-run' : 'sync'} started`);
    const result = await runSync(config, { dryRun });
    outputChannel.appendLine(result);
    vscode.window.showInformationMessage(dryRun ? 'Dry run complete' : 'Sync complete');
}

async function runTeleportTest(config: SftpConfig): Promise<void> {
    outputChannel.appendLine('[teleport] checking session');
    const result = await testTeleport(config);
    outputChannel.appendLine(result);
    vscode.window.showInformationMessage('Teleport session is active');
}

function startWatcher(context: vscode.ExtensionContext, config: SftpConfig): void {
    startWatching(context, config, outputChannel);
    vscode.window.showInformationMessage('SFTP watcher started');
}

function stopWatcher(): void {
    stopWatching();
    vscode.window.showInformationMessage('SFTP watcher stopped');
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

    const styleUri = panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'config.css'))
    ).toString();
    const scriptUri = panel.webview.asWebviewUri(
        vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview', 'config.js'))
    ).toString();

    html = html.replace(/{{styleUri}}/g, styleUri).replace(/{{scriptUri}}/g, scriptUri);

    panel.webview.html = html;

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'ready':
                panel.webview.postMessage({ command: 'load', config: getConfiguration() });
                break;
            case 'save':
                await saveConfiguration(context, message.config);
                panel.webview.postMessage({ command: 'saved' });
                vscode.window.showInformationMessage('SFTP configuration saved');
                break;
            case 'test': {
                try {
                    const cfg = await loadConfig();
                    const result = await testTeleport(cfg);
                    panel.webview.postMessage({ command: 'testResult', status: 'ok', detail: result });
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'testResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'sync': {
                try {
                    const cfg = await loadConfig();
                    const result = await runSync(cfg);
                    outputChannel.appendLine(result);
                    panel.webview.postMessage({ command: 'syncResult', status: 'ok', detail: result });
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'syncResult', status: 'error', detail: error.message });
                }
                break;
            }
            case 'dryRun': {
                try {
                    const cfg = await loadConfig();
                    const result = await runSync(cfg, { dryRun: true });
                    outputChannel.appendLine(result);
                    panel.webview.postMessage({ command: 'syncResult', status: 'ok', detail: result });
                } catch (error: any) {
                    panel.webview.postMessage({ command: 'syncResult', status: 'error', detail: error.message });
                }
                break;
            }
        }
    });

    panel.webview.postMessage({ command: 'load', config: getConfiguration() });
}

export function deactivate() {
    stopWatching();
}
