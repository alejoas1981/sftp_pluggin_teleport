import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// @ts-ignore
import { loadExtension } from '../../test/proxyquire-helper.cjs';

describe('extension', () => {
    let tempDir: string, storageRoot: string;
    let context: any;
    let syncCalls: string[];
    let watcherCalls: string[];
    let syncMock: any;
    let watcherMock: any;
    let ext: any;

    beforeEach(() => {
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-storage-'));
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-test-'));
        (vscode as any)._reset();
        (vscode as any)._values['mode'] = 'sftp';
        (vscode as any)._values['localPath'] = tempDir;
        syncCalls = [];
        watcherCalls = [];
        syncMock = {
            runSync: async (config: any, options: any) => {
                syncCalls.push(`runSync:${options?.dryRun ?? 'false'}`);
                return 'SYNC COMPLETE';
            },
            uploadFile: async (_config: any, localPath: string) => { syncCalls.push(`uploadFile:${localPath}`); },
            downloadFile: async (_config: any, localPath: string) => { syncCalls.push(`downloadFile:${localPath}`); },
            deleteRemoteFile: async (_config: any, localPath: string) => { syncCalls.push(`deleteRemoteFile:${localPath}`); },
            syncFile: async (_config: any, localPath: string) => { syncCalls.push(`syncFile:${localPath}`); return 'In sync'; },
            testConnection: async () => { syncCalls.push('testConnection'); return 'Connection successful'; },
            ensureTeleportSession: async () => { syncCalls.push('ensureTeleportSession'); return 'logged in'; },
        };
        watcherMock = {
            startWatching: () => { watcherCalls.push('startWatching'); },
            stopWatching: () => { watcherCalls.push('stopWatching'); },
        };
        const state = new Map<string, any>();
        context = {
            globalStorageUri: { fsPath: storageRoot },
            workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: any) => { state.set(key, value); } },
            subscriptions: [] as any[],
            secrets: { get: async () => undefined },
            extensionPath: process.cwd(),
        };
        ext = loadExtension({ './sync': syncMock, './watcher': watcherMock });
    });

    afterEach(() => {
        try {
            ext.deactivate();
        } catch {}
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(storageRoot, { recursive: true, force: true });
    });

    it('activate registers commands and disposables', async () => {
        await ext.activate(context);

        expect(context.subscriptions.length).to.be.greaterThan(0);
        expect((vscode as any)._commands['sftpPluggin.syncNow']).to.be.a('function');
        expect((vscode as any)._commands['sftpPluggin.uploadActiveFile']).to.be.a('function');
        expect((vscode as any)._willSaveListeners).to.have.length(1);
        expect((vscode as any)._didSaveListeners).to.have.length(1);
    });

    it('syncNow command runs sync', async () => {
        await ext.activate(context);

        const handler = (vscode as any)._commands['sftpPluggin.syncNow'];
        await handler();

        expect(syncCalls).to.include('runSync:false');
        const output = (vscode as any)._outputChannels[0];
        expect(output.lines).to.include('SYNC COMPLETE');
    });

    it('uploadActiveFile command uploads the active editor file', async () => {
        const file = path.join(tempDir, 'active.txt');
        fs.writeFileSync(file, 'x');
        (vscode as any).window.activeTextEditor = {
            document: {
                uri: vscode.Uri.file(file),
                fileName: file,
            }
        };

        await ext.activate(context);

        const handler = (vscode as any)._commands['sftpPluggin.uploadActiveFile'];
        await handler();

        expect(syncCalls).to.include(`uploadFile:${file}`);
        const output = (vscode as any)._outputChannels[0];
        expect(output.lines.some((line: string) => line.includes('Uploaded'))).to.be.true;
    });

    it('deactivate stops watcher', () => {
        ext.deactivate();
        expect(watcherCalls).to.include('stopWatching');
    });
    for (const fail of [false, true]) {
        it(`continues with closed Webview and restores ${fail ? 'failure' : 'success'} on reopen`, async () => {
            const original = (vscode.window as any).createWebviewPanel,
                panels: any[] = [];
            let release!: () => void, started!: () => void;
            const blocked = new Promise<void>((resolve) => { release = resolve; }),
                running = new Promise<void>((resolve) => { started = resolve; });
            (vscode.window as any).createWebviewPanel = () => {
                let handler: any, disposeHandler: any, disposed = false;
                const messages: any[] = [], panel = {
                    webview: { html: '', onDidReceiveMessage: (callback: any) => { handler = callback; },
                        postMessage: (message: any) => {
                            if (disposed) { throw new Error('Webview disposed'); }
                            messages.push(message); return Promise.resolve(true);
                        } },
                    onDidDispose: (callback: any) => { disposeHandler = callback; },
                    dispose: () => { disposed = true; disposeHandler(); },
                    receive: (message: any) => handler(message), messages
                };
                panels.push(panel); return panel;
            };
            syncMock.runSync = async (_config: any, options: any) => {
                syncCalls.push('transfer'); started(); await blocked;
                options.onLog('DOWNLOAD file.txt — done\n');
                options.onState({ current: 1, total: 1, percent: 99 });
                if (fail) { throw new Error('Connection lost'); }
                return 'SYNC COMPLETE';
            };
            try {
                await ext.activate(context);
                (vscode as any)._commands['sftpPluggin.openConfig']();
                const pending = panels[0].receive({ command: 'sync' });
                await running;
                panels[0].dispose();
                (vscode as any)._commands['sftpPluggin.openConfig']();
                await panels[1].receive({ command: 'getSyncState' });
                expect(panels[1].messages.slice(-1)[0].state.status).to.equal('running');
                await panels[1].receive({ command: 'sync' });
                expect(syncCalls.filter((call) => call === 'transfer')).to.have.length(1);
                release(); await pending;
                await panels[1].receive({ command: 'getSyncState' });
                const state = panels[1].messages.slice(-1)[0].state;
                expect(state.status).to.equal(fail ? 'error' : 'complete');
                expect(state.result).to.equal(fail ? 'Connection lost' : 'SYNC COMPLETE');
                expect((vscode as any)._statusBarItems[0].text).to.include(fail ? 'failed' : 'Sync complete');
                panels[1].dispose();
            } finally {
                release();
                (vscode.window as any).createWebviewPanel = original;
            }
        });
    }

});
