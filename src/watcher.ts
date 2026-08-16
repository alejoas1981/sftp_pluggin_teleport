import * as vscode from 'vscode';
import { SftpConfig } from './config';

let activeWatcher: vscode.FileSystemWatcher | undefined, debounceTimer: NodeJS.Timeout | undefined;

export function startWatching(
    context: vscode.ExtensionContext,
    config: SftpConfig,
    syncFn: () => Promise<void>,
    output: vscode.OutputChannel
): void {
    stopWatching();

    if (!config.localPath) {
        throw new Error('localPath is required to start watching');
    }

    const base = vscode.Uri.file(config.localPath), pattern = new vscode.RelativePattern(base, '**');

    activeWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

    const onEvent = (uri: vscode.Uri) => {
        output.appendLine(`[watch] ${uri.fsPath}`);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            syncFn()
                .then(() => output.appendLine('[watch] sync ok'))
                .catch((error) => output.appendLine(`[sync error] ${error.message}`));
        }, config.debounceMs || 300);
    };

    activeWatcher.onDidChange(onEvent);
    activeWatcher.onDidCreate(onEvent);
    activeWatcher.onDidDelete(onEvent);

    context.subscriptions.push(activeWatcher);
    output.appendLine('[watch] started');
}

export function stopWatching(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
    if (activeWatcher) {
        activeWatcher.dispose();
        activeWatcher = undefined;
    }
}
