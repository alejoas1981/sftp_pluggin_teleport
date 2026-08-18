import * as vscode from 'vscode';
import * as path from 'path';
import PQueue from 'p-queue';
import { SftpConfig } from './config';
import { getIgnorePatterns, isIgnored } from './utils';

let activeWatcher: vscode.FileSystemWatcher | undefined,
    activeSyncQueue: PQueue | undefined,
    debounceTimer: NodeJS.Timeout | undefined;

/**
 * Starts a file watcher that triggers syncFn after the configured debounce.
 * @param context - The VS Code extension context.
 * @param config - The SFTP configuration.
 * @param syncFn - A function that performs the sync.
 * @param output - The output channel for logging.
 * @returns {void}
 */
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

    /**
     * Handles a file system event from the watcher.
     * @param uri - The changed file URI.
     * @returns {void}
     */
    const onEvent = (uri: vscode.Uri) => {
        const rel = path.relative(config.localPath!, uri.fsPath).replace(/\\/g, '/');
        if (isIgnored(rel, getIgnorePatterns(config.ignore ?? []))) { return; }
        output.appendLine(`[watch] ${uri.fsPath}`);
        if (debounceTimer) { clearTimeout(debounceTimer); }
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

/**
 * Stops the active file watcher and clears pending syncs.
 * @returns {void}
 */
export function stopWatching(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
    if (activeSyncQueue) { activeSyncQueue.clear(); activeSyncQueue = undefined; }
    if (activeWatcher) { activeWatcher.dispose(); activeWatcher = undefined; }
}
