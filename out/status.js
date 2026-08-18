"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStatusBar = createStatusBar;
exports.updateSftpStatus = updateSftpStatus;
exports.startLoading = startLoading;
exports.stopLoading = stopLoading;
const vscode = __importStar(require("vscode"));
const progress_1 = require("./progress");
let statusBarItem, loadingInterval;
/**
 * Creates and shows the SFTP status bar item.
 * @param context - The VS Code extension context.
 * @returns {void}
 */
function createStatusBar(context) {
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
function updateSftpStatus(text, tooltip) {
    if (!statusBarItem) {
        return;
    }
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip || text.replace(/\$\([^)]+\)\s*/g, '').trim();
}
/**
 * Starts an animated loading indicator on the status bar.
 * @returns {void}
 */
function startLoading() {
    if (loadingInterval) {
        clearInterval(loadingInterval);
    }
    let percent = 0;
    updateSftpStatus(`$(sync) ${(0, progress_1.renderProgress)(0)}`);
    loadingInterval = setInterval(() => {
        percent += 1;
        if (percent > 95) {
            percent = 95;
        }
        updateSftpStatus(`$(sync) ${(0, progress_1.renderProgress)(percent)}`);
    }, 100);
}
/**
 * Stops the loading animation and restores the status bar message.
 * @param text - Optional status text to display.
 * @returns {void}
 */
function stopLoading(text) {
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = undefined;
    }
    updateSftpStatus(text || '$(check) SFTP: ready');
}
