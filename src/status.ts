import * as vscode from 'vscode';
import { renderProgress } from './progress';

let statusBarItem: vscode.StatusBarItem | undefined, loadingInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Creates and shows the SFTP status bar item.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
export function createStatusBar(context: vscode.ExtensionContext): void {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = 'SFTP';
    statusBarItem.tooltip = 'SFTP Plugin - click to open configuration';
    statusBarItem.command = 'sftpPluggin.openConfig';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

/**
 * Updates the SFTP status bar text and tooltip.
 * @param text - The status text to display.
 * @param tooltip - Optional tooltip text.
 * @returns {void}
 */
export function updateSftpStatus(text: string, tooltip?: string): void {
    if (!statusBarItem) { return; }
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip || text.replace(/\$\([^)]+\)\s*/g, '').trim();
}

/**
 * Starts an animated loading indicator on the status bar.
 * @returns {void}
 */
export function startLoading(): void {
    if (loadingInterval) { clearInterval(loadingInterval); }
    let percent = 0;
    updateSftpStatus(`$(sync) ${renderProgress(0)}`);
    loadingInterval = setInterval(() => {
        percent += 1;
        if (percent > 95) { percent = 95; }
        updateSftpStatus(`$(sync) ${renderProgress(percent)}`);
    }, 100);
}

/**
 * Stops the loading animation and restores the status bar message.
 * @param text - Optional status text to display.
 * @returns {void}
 */
export function stopLoading(text?: string): void {
    if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = undefined; }
    updateSftpStatus(text || '$(check) SFTP: ready');
}
