import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function getExtensionUri(context: vscode.ExtensionContext, relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(context.extensionPath, relativePath));
}

export function readFileSync(context: vscode.ExtensionContext, relativePath: string): string {
    return fs.readFileSync(path.join(context.extensionPath, relativePath), 'utf8');
}