import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { startWatching, stopWatching } from '../watcher';

describe('watcher', () => {
    let tempDir: string;
    let context: any;
    let output: any;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
        (vscode as any)._reset();
        context = { subscriptions: [] };
        output = { lines: [], appendLine(msg: string) { this.lines.push(msg); } };
    });

    afterEach(() => {
        stopWatching();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('throws when localPath is missing', () => {
        expect(() => startWatching(context, { localPath: undefined } as any, async () => {}, output)).to.throw('localPath is required to start watching');
    });

    it('creates a watcher and registers it on the context', () => {
        startWatching(context, { localPath: tempDir, ignore: [], debounceMs: 50 }, async () => {}, output);

        expect(context.subscriptions).to.have.length(1);
        expect(output.lines).to.include('[watch] started');
    });

    it('debounces file create events and triggers sync', async () => {
        let calls = 0;
        const syncFn = async () => { calls += 1; };

        startWatching(context, { localPath: tempDir, ignore: [], debounceMs: 50 }, syncFn, output);
        const watcher = context.subscriptions[0];
        const filePath = path.join(tempDir, 'new.txt');
        watcher._trigger('didCreate', vscode.Uri.file(filePath));

        await new Promise((resolve) => setTimeout(resolve, 120));

        expect(calls).to.equal(1);
        expect(output.lines).to.include('[watch] sync ok');
    });

    it('ignores files matching ignore patterns', async () => {
        let calls = 0;
        const syncFn = async () => { calls += 1; };

        startWatching(context, { localPath: tempDir, ignore: ['*.log'], debounceMs: 50 }, syncFn, output);
        const watcher = context.subscriptions[0];
        const filePath = path.join(tempDir, 'debug.log');
        watcher._trigger('didCreate', vscode.Uri.file(filePath));

        await new Promise((resolve) => setTimeout(resolve, 120));

        expect(calls).to.equal(0);
    });
});
