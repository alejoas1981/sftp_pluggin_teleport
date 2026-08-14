import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem | undefined;

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
