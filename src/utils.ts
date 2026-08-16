import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolves an absolute file URI relative to the extension path.
 * @param context - The VS Code extension context.
 * @param relativePath - The path relative to the extension root.
 * @returns {vscode.Uri} The resolved file URI.
 */
export function getExtensionUri(context: vscode.ExtensionContext, relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(context.extensionPath, relativePath));
}

/**
 * Reads a file from the extension path as a UTF-8 string.
 * @param context - The VS Code extension context.
 * @param relativePath - The path relative to the extension root.
 * @returns {string} The file contents.
 */
export function readFileSync(context: vscode.ExtensionContext, relativePath: string): string {
    return fs.readFileSync(path.join(context.extensionPath, relativePath), 'utf8');
}