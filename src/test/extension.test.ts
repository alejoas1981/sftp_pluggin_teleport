import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// @ts-ignore
import { loadExtension } from '../../test/proxyquire-helper.cjs';

describe('extension', () => {
    let tempDir: string;
    let context: any;
    let syncCalls: string[];
    let watcherCalls: string[];
    let syncMock: any;
    let watcherMock: any;
    let ext: any;

    beforeEach(() => {
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
        context = {
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
});
