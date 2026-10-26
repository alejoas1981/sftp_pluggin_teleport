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
        (vscode.workspace as any).textDocuments = [];
        (vscode as any)._values['debounceMs'] = 50;
        syncMock = {
            uploadChangedFiles: async () => { syncCalls.push('uploadChanged'); return 'UPLOAD COMPLETE'; },
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
            cancelActiveTransfer: () => { syncCalls.push('cancelActiveTransfer'); return true; },
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
        expect((vscode as any)._commands['sftpPluggin.cancelTransfer']).to.be.a('function');
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

    function save(file: string, reason: number) {
        const document = { fileName: file, uri: vscode.Uri.file(file) };
        (vscode as any)._willSaveListeners[0]({ document, reason });
        (vscode as any)._didSaveListeners[0](document);
    }

    it('coalesces manual saves and saves other dirty project documents before uploading', async () => {
        let saved = false;
        (vscode.workspace as any).textDocuments = [{ isDirty: true, fileName: path.join(tempDir, 'other.txt'),
            uri: vscode.Uri.file(path.join(tempDir, 'other.txt')), save: async () => {
                saved = true; save(path.join(tempDir, 'other.txt'), 1); return true;
            } }];
        syncMock.uploadChangedFiles = async () => { expect(saved).to.equal(true); syncCalls.push('uploadChanged'); return 'UPLOAD COMPLETE'; };
        ext.activate(context);
        save(path.join(tempDir, 'a.txt'), 1); save(path.join(tempDir, 'b.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(syncCalls.filter((call) => call === 'uploadChanged')).to.have.length(1);
        expect(syncCalls.some((call) => call.startsWith('syncFile') || call.startsWith('runSync'))).to.equal(false);
    });

    it('honors disabled save modes and excludes adjacent roots', async () => {
        (vscode as any)._values.uploadOnSave = false;
        (vscode as any)._values.uploadOnAutoSave = false;
        ext.activate(context);
        save(path.join(tempDir, 'a.txt'), 1); save(path.join(tempDir, 'a.txt'), 2);
        (vscode as any)._values.uploadOnSave = true;
        save(tempDir + '-other/a.txt', 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(syncCalls).not.to.include('uploadChanged');
    });

    it('queues another upload when a save arrives during a running upload', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        syncMock.uploadChangedFiles = async () => {
            syncCalls.push('uploadChanged');
            if (syncCalls.filter((call) => call === 'uploadChanged').length === 1) { await blocked; }
            return 'UPLOAD COMPLETE';
        };
        ext.activate(context); save(path.join(tempDir, 'a.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        save(path.join(tempDir, 'b.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(syncCalls.filter((call) => call === 'uploadChanged')).to.have.length(1);
        release(); await new Promise((resolve) => setTimeout(resolve, 100));
        expect(syncCalls.filter((call) => call === 'uploadChanged')).to.have.length(2);
    });

    it('cancels and restarts an obsolete automatic upload after a working-tree update', async () => {
        (vscode as any)._values.uploadOnAutoSave = true;
        const batches: string[][] = [];
        let rejectTransfer: ((error: Error) => void) | undefined;
        syncMock.uploadChangedFiles = async (_config: any, options: any) => {
            batches.push(options.files);
            if (batches.length === 1) {
                await new Promise<never>((_resolve, reject) => { rejectTransfer = reject; });
            }
            return 'UPLOAD COMPLETE';
        };
        syncMock.cancelActiveTransfer = () => {
            syncCalls.push('cancelActiveTransfer');
            rejectTransfer?.(new Error('Transfer cancelled'));
            return true;
        };
        ext.activate(context);
        save(path.join(tempDir, 'before-pull.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        (vscode as any)._watchers[0]._trigger('didChange', vscode.Uri.file(path.join(tempDir, 'after-pull.txt')));
        await new Promise((resolve) => setTimeout(resolve, 180));
        expect(syncCalls.filter((call) => call === 'cancelActiveTransfer')).to.have.length(1);
        expect(batches).to.have.length(2);
        expect(batches[1]).to.include('after-pull.txt');
        const output = (vscode as any)._outputChannels[0];
        expect(output.lines.some((line: string) => line.includes('restarting with the latest version'))).to.equal(true);
    });

    it('uploads external filesystem edits when auto-save uploads are enabled', async () => {
        (vscode as any)._values.uploadOnAutoSave = true;
        ext.activate(context);
        (vscode as any)._watchers[0]._trigger('didChange', vscode.Uri.file(path.join(tempDir, 'ai-edit.txt')));
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(syncCalls).to.include('uploadChanged');
    });

    it('queues filesystem edits with auto upload disabled and flushes only those paths on manual save', async () => {
        const batches: string[][] = [];
        syncMock.uploadChangedFiles = async (_config: any, options: any) => { batches.push(options.files); return 'UPLOAD COMPLETE'; };
        (vscode as any)._values.uploadOnAutoSave = false;
        ext.activate(context);
        (vscode as any)._watchers[0]._trigger('didChange', vscode.Uri.file(path.join(tempDir, 'ai-edit.txt')));
        await new Promise((resolve) => setTimeout(resolve, 70));
        expect(batches).to.have.length(0);
        save(path.join(tempDir, 'active.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(batches[0].sort()).to.deep.equal(['active.txt', 'ai-edit.txt']);
        save(path.join(tempDir, 'active.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(batches[1]).to.deep.equal(['active.txt']);
    });

    it('retains failed paths for the next save', async () => {
        const batches: string[][] = [];
        syncMock.uploadChangedFiles = async (_config: any, options: any) => {
            batches.push(options.files);
            if (batches.length === 1) { throw new Error('offline'); }
            return 'UPLOAD COMPLETE';
        };
        ext.activate(context); save(path.join(tempDir, 'first.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        save(path.join(tempDir, 'second.txt'), 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(batches[1].sort()).to.deep.equal(['first.txt', 'second.txt']);
    });

});
