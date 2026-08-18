"use strict";
const updates = [];
const values = {};
const secrets = {};
const statusBarItems = [];
const watchers = [];
const commands = {};
const outputChannels = [];
const willSaveListeners = [];
const didSaveListeners = [];
function reset() {
    updates.length = 0;
    Object.keys(values).forEach((k) => { delete values[k]; });
    Object.keys(secrets).forEach((k) => { delete secrets[k]; });
    statusBarItems.length = 0;
    watchers.length = 0;
    Object.keys(commands).forEach((k) => { delete commands[k]; });
    outputChannels.length = 0;
    willSaveListeners.length = 0;
    didSaveListeners.length = 0;
}
function getValue(key, defaultValue) {
    return key in values ? values[key] : defaultValue;
}
function createStatusBarItem() {
    const item = {
        text: '',
        tooltip: '',
        command: '',
        shown: false,
        show() { this.shown = true; },
        hide() { this.shown = false; },
        dispose() { }
    };
    statusBarItems.push(item);
    return item;
}
function createFileSystemWatcher(_pattern, _ignoreCreate, _ignoreChange, _ignoreDelete) {
    const listeners = {};
    const watcher = {
        onDidCreate(fn) { (listeners.didCreate = listeners.didCreate || []).push(fn); },
        onDidChange(fn) { (listeners.didChange = listeners.didChange || []).push(fn); },
        onDidDelete(fn) { (listeners.didDelete = listeners.didDelete || []).push(fn); },
        _trigger(event, uri) { (listeners[event] || []).forEach((fn) => fn(uri)); },
        dispose() { }
    };
    watchers.push(watcher);
    return watcher;
}
function createOutputChannel(name) {
    const channel = {
        name,
        lines: [],
        append(value) { this.lines.push(value); },
        appendLine(value) { this.lines.push(value); },
        clear() { this.lines.length = 0; },
        show() { },
        hide() { },
        dispose() { }
    };
    outputChannels.push(channel);
    return channel;
}
function makeUri(filePath, scheme = 'file') {
    return {
        scheme,
        fsPath: filePath,
        toString() { return `${scheme}://${filePath}`; }
    };
}
function registerCommand(command, handler) {
    commands[command] = handler;
    return { dispose() { delete commands[command]; } };
}
function executeCommand(command, ...args) {
    const handler = commands[command];
    return handler ? handler(...args) : undefined;
}
const vscodeMock = {
    _updates: updates,
    _reset: reset,
    _values: values,
    _secrets: secrets,
    _statusBarItems: statusBarItems,
    _watchers: watchers,
    _commands: commands,
    _outputChannels: outputChannels,
    _willSaveListeners: willSaveListeners,
    _didSaveListeners: didSaveListeners,
    workspace: {
        workspaceFolders: [],
        getConfiguration: (_section) => ({
            get: (key, defaultValue) => getValue(key, defaultValue),
            update: (key, value, global) => {
                updates.push({ key, value, global });
                return Promise.resolve();
            },
            inspect: () => undefined
        }),
        createFileSystemWatcher,
        onWillSaveTextDocument: (fn) => { willSaveListeners.push(fn); return { dispose() { } }; },
        onDidSaveTextDocument: (fn) => { didSaveListeners.push(fn); return { dispose() { } }; },
        openTextDocument: async (uri) => ({ uri, fileName: uri.fsPath, languageId: '', version: 1, isDirty: false })
    },
    window: {
        activeTextEditor: undefined,
        createStatusBarItem,
        createOutputChannel,
        showErrorMessage: async (...args) => args[args.length - 1],
        showInformationMessage: async (...args) => args[args.length - 1],
        showWarningMessage: async (...args) => args[args.length - 1],
        showTextDocument: async (doc) => doc,
        createWebviewPanel: (_viewType, title) => ({
            title,
            webview: {
                html: '',
                onDidReceiveMessage: () => ({ dispose() { } }),
                postMessage: async () => true
            },
            onDidDispose: () => ({ dispose() { } }),
            reveal: () => { },
            dispose: () => { }
        })
    },
    commands: {
        registerCommand,
        executeCommand
    },
    env: {
        openExternal: async (_target) => true
    },
    StatusBarAlignment: {
        Left: 0,
        Right: 1
    },
    ViewColumn: {
        One: 1,
        Two: 2
    },
    TextDocumentSaveReason: {
        Manual: 1,
        AfterDelay: 2,
        FocusOut: 3
    },
    Uri: {
        file: (filePath) => makeUri(filePath, 'file'),
        parse: (url) => {
            const [scheme, filePath] = url.split('://');
            return makeUri(filePath ?? url, scheme ?? 'file');
        }
    },
    RelativePattern: class {
        constructor(base, pattern) {
            this.base = base;
            this.pattern = pattern;
        }
    }
};
module.exports = vscodeMock;
