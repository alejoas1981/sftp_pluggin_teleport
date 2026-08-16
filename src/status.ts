import * as vscode from 'vscode';
import { renderProgress } from './progress';

let statusBarItem: vscode.StatusBarItem | undefined, loadingInterval: ReturnType<typeof setInterval> | undefined;

export function createStatusBar(context: vscode.ExtensionContext): void {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = 'SFTP';
    statusBarItem.tooltip = 'SFTP Plugin - click to open configuration';
    statusBarItem.command = 'sftpPluggin.openConfig';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

export function updateSftpStatus(text: string, tooltip?: string): void {
    if (!statusBarItem) { return; }
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip || text.replace(/\$\([^)]+\)\s*/g, '').trim();
}

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

export function stopLoading(text?: string): void {
    if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = undefined; }
    updateSftpStatus(text || '$(check) SFTP: ready');
}
