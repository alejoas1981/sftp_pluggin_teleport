import * as vscode from 'vscode';
import * as path from 'path';
import PQueue from 'p-queue';
import { SftpConfig } from './config';
import { isIgnored } from './utils';

let activeWatcher: vscode.FileSystemWatcher | undefined;
let activeSyncQueue: PQueue | undefined;
let debounceTimer: NodeJS.Timeout | undefined;

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

    const base = vscode.Uri.file(config.localPath),
        pattern = new vscode.RelativePattern(base, '**');

    activeWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    activeSyncQueue = new PQueue({ concurrency: 1 });

    const onEvent = (uri: vscode.Uri) => {
        const rel = path.relative(config.localPath!, uri.fsPath).replace(/\\/g, '/');
        if (isIgnored(rel, config.ignore ?? [])) {
            return;
        }
        output.appendLine(`[watch] ${uri.fsPath}`);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            activeSyncQueue!.add(() => syncFn()
                .then(() => output.appendLine('[watch] sync ok'))
                .catch((error: any) => output.appendLine(`[sync error] ${error.message}`)));
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
    if (activeSyncQueue) {
        activeSyncQueue.clear();
        activeSyncQueue = undefined;
    }
    if (activeWatcher) {
        activeWatcher.dispose();
        activeWatcher = undefined;
    }
}
