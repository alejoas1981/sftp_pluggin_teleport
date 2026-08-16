import * as vscode from 'vscode';
import { SftpConfig } from './config';

let activeWatcher: vscode.FileSystemWatcher | undefined, debounceTimer: NodeJS.Timeout | undefined;

/**
 * Starts watching the configured local path for file changes and triggers syncs.
 * @param context - The VS Code extension context.
 * @param config - The SFTP configuration.
 * @param syncFn - The async function to call when a change is detected.
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

    const base = vscode.Uri.file(config.localPath), pattern = new vscode.RelativePattern(base, '**');

    activeWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

    /**
     * Handles a file system event by debouncing and triggering a sync.
     * @param uri - The URI of the changed file.
     * @returns {void}
     */
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

/**
 * Stops the active file system watcher and clears pending debounces.
 * @returns {void}
 */
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
