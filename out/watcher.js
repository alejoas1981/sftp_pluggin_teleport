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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWatching = startWatching;
exports.stopWatching = stopWatching;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const p_queue_1 = __importDefault(require("p-queue"));
const utils_1 = require("./utils");
let activeWatcher;
let activeSyncQueue;
let debounceTimer;
function startWatching(context, config, syncFn, output) {
    stopWatching();
    if (!config.localPath) {
        throw new Error('localPath is required to start watching');
    }
    const base = vscode.Uri.file(config.localPath), pattern = new vscode.RelativePattern(base, '**');
    activeWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    activeSyncQueue = new p_queue_1.default({ concurrency: 1 });
    const onEvent = (uri) => {
        const rel = path.relative(config.localPath, uri.fsPath).replace(/\\/g, '/');
        if ((0, utils_1.isIgnored)(rel, config.ignore ?? [])) {
            return;
        }
        output.appendLine(`[watch] ${uri.fsPath}`);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            activeSyncQueue.add(() => syncFn()
                .then(() => output.appendLine('[watch] sync ok'))
                .catch((error) => output.appendLine(`[sync error] ${error.message}`)));
        }, config.debounceMs || 300);
    };
    activeWatcher.onDidChange(onEvent);
    activeWatcher.onDidCreate(onEvent);
    activeWatcher.onDidDelete(onEvent);
    context.subscriptions.push(activeWatcher);
    output.appendLine('[watch] started');
}
function stopWatching() {
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
