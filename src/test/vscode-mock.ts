const updates: { key: string; value: any; global: boolean }[] = [];
const values: Record<string, any> = {};
const secrets: Record<string, string | undefined> = {};
const statusBarItems: any[] = [];
const watchers: any[] = [];
const commands: Record<string, (...args: any[]) => any> = {};
const outputChannels: any[] = [];
const willSaveListeners: ((e: any) => void)[] = [];
const didSaveListeners: ((doc: any) => void)[] = [];

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

function getValue(key: string, defaultValue?: any) {
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
        dispose() {}
    };
    statusBarItems.push(item);
    return item;
}

function createFileSystemWatcher(_pattern: any, _ignoreCreate?: boolean, _ignoreChange?: boolean, _ignoreDelete?: boolean) {
    const listeners: Record<string, ((uri: any) => void)[]> = {};
    const watcher = {
        onDidCreate(fn: (uri: any) => void) { (listeners.didCreate = listeners.didCreate || []).push(fn); },
        onDidChange(fn: (uri: any) => void) { (listeners.didChange = listeners.didChange || []).push(fn); },
        onDidDelete(fn: (uri: any) => void) { (listeners.didDelete = listeners.didDelete || []).push(fn); },
        _trigger(event: string, uri: any) { (listeners[event] || []).forEach((fn) => fn(uri)); },
        dispose() {}
    };
    watchers.push(watcher);
    return watcher;
}

function createOutputChannel(name: string) {
    const channel = {
        name,
        lines: [] as string[],
        append(value: string) { this.lines.push(value); },
        appendLine(value: string) { this.lines.push(value); },
        clear() { this.lines.length = 0; },
        show() {},
        hide() {},
        dispose() {}
    };
    outputChannels.push(channel);
    return channel;
}

function makeUri(filePath: string, scheme = 'file') {
    return {
        scheme,
        fsPath: filePath,
        toString() { return `${scheme}://${filePath}`; }
    };
}

function registerCommand(command: string, handler: (...args: any[]) => any) {
    commands[command] = handler;
    return { dispose() { delete commands[command]; } };
}

function executeCommand(command: string, ...args: any[]) {
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
        workspaceFolders: [] as any[],
        getConfiguration: (_section: string) => ({
            get: (key: string, defaultValue?: any) => getValue(key, defaultValue),
            update: (key: string, value: any, global: boolean) => {
                updates.push({ key, value, global });
                return Promise.resolve();
            },
            inspect: () => undefined
        }),
        createFileSystemWatcher,
        onWillSaveTextDocument: (fn: (e: any) => void) => { willSaveListeners.push(fn); return { dispose() {} }; },
        onDidSaveTextDocument: (fn: (doc: any) => void) => { didSaveListeners.push(fn); return { dispose() {} }; },
        openTextDocument: async (uri: any) => ({ uri, fileName: uri.fsPath, languageId: '', version: 1, isDirty: false })
    },
    window: {
        activeTextEditor: undefined as any,
        createStatusBarItem,
        createOutputChannel,
        showErrorMessage: async (...args: any[]) => args[args.length - 1],
        showInformationMessage: async (...args: any[]) => args[args.length - 1],
        showWarningMessage: async (...args: any[]) => args[args.length - 1],
        showTextDocument: async (doc: any) => doc,
        createWebviewPanel: (_viewType: string, title: string) => ({
            title,
            webview: {
                html: '',
                onDidReceiveMessage: () => ({ dispose() {} }),
                postMessage: async () => true
            },
            onDidDispose: () => ({ dispose() {} }),
            reveal: () => {},
            dispose: () => {}
        })
    },
    commands: {
        registerCommand,
        executeCommand
    },
    env: {
        openExternal: async (_target: any) => true
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
        file: (filePath: string) => makeUri(filePath, 'file'),
        parse: (url: string) => {
            const [scheme, filePath] = url.split('://');
            return makeUri(filePath ?? url, scheme ?? 'file');
        }
    },
    RelativePattern: class {
        base: any;
        pattern: string;
        constructor(base: any, pattern: string) {
            this.base = base;
            this.pattern = pattern;
        }
    }
};

export = vscodeMock;
