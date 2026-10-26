import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

interface FakeElement {
    hidden: boolean;
    disabled: boolean;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    scrolled: boolean;
    className: string;
    textContent: string;
    value: string;
    checked: boolean;
    type: string;
    style: Record<string, string>;
    children: FakeElement[];
    _listeners: Record<string, ((...args: any[]) => void)[]>;
    classList: { list: Set<string>; toggle: (cls: string, force?: boolean) => void };
    addEventListener: (event: string, handler: (...args: any[]) => void) => void;
    appendChild: (child: FakeElement) => void;
    click: () => void;
}

/**
 * Creates a fake DOM element for testing the webview config panel.
 * @returns {FakeElement} A fake element with listener and child helpers.
 */
function createElement(): FakeElement {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {},
        children: FakeElement[] = [],
        classes = new Set<string>();

    const el: any = {
        hidden: true,
        disabled: false,
        scrollTop: 0,
        scrollHeight: 260,
        clientHeight: 260,
        scrolled: false,
        scrollIntoView: () => { el.scrolled = true; },
        className: '',
        textContent: '',
        value: '',
        checked: false,
        type: '',
        style: {},
        children,
        _listeners: listeners,
        classList: {
            list: classes,
            toggle: (cls: string, force?: boolean) => {
                if (force) { classes.add(cls); } else { classes.delete(cls); }
            }
        },
        addEventListener: (event: string, handler: (...args: any[]) => void) => {
            listeners[event] = listeners[event] || [];
            listeners[event].push(handler);
        },
        appendChild: (child: FakeElement) => {
            children.push(child);
        },
        click: () => {
            (listeners.click || []).forEach((h) => h());
        }
    };

    let ownText = '';
    Object.defineProperty(el, 'textContent', {
        get: () => ownText + children.map((child) => child.textContent).join(''),
        set: (value: string) => { ownText = value; children.length = 0; }
    });

    Object.defineProperty(el, 'innerHTML', {
        get: () => '',
        set: (value: string) => {
            if (value === '') { children.length = 0; }
        }
    });

    return el as FakeElement;
}

describe('webview config panel', () => {
    const code = fs.readFileSync(path.join('src', 'webview', 'config.js'), 'utf8');

    let messages: any[] = [];
    const elements: Record<string, FakeElement> = {},
        windowListeners: Record<string, ((...args: any[]) => void)[]> = {};
    let windowStub: any;

    beforeEach(() => {
        messages = [];

        const documentStub = {
            readyState: 'loading',
            getElementById: (id: string) => {
                if (!elements[id]) { elements[id] = createElement(); }
                return elements[id];
            },
            querySelector: () => createElement(),
            querySelectorAll: () => [],
            createElement: () => createElement()
        };

        windowStub = {
            addEventListener: (event: string, handler: (...args: any[]) => void) => {
                windowListeners[event] = windowListeners[event] || [];
                windowListeners[event].push(handler);
            },
            postMessageToListeners: (event: { data: any }) => {
                (windowListeners.message || []).forEach((h) => h(event));
            }
        };

        const sandbox = {
            document: documentStub,
            window: windowStub,
            acquireVsCodeApi: () => ({ postMessage: (msg: any) => messages.push(msg) }),
            setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
            clearInterval: (id: any) => clearInterval(id),
            setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
            clearTimeout,
            console
        };

        for (const id of Object.keys(elements)) {
            delete elements[id];
        }
        for (const event of Object.keys(windowListeners)) {
            delete windowListeners[event];
        }

        vm.runInNewContext(code, vm.createContext(sandbox), { filename: 'config.js' });
    });

    it('shows loading bar and stops on result', async () => {
        const syncButton = elements['sync-now'];
        expect(syncButton).to.exist;

        syncButton.click();

        expect(elements.loader.style.display).to.equal('block');
        expect(elements.status.style.display).to.equal('none');
        expect(elements['progress-bar'].children.length).to.equal(20);
        expect(messages).to.deep.include({ command: 'sync' });

        await new Promise((resolve) => setTimeout(resolve, 320));
        expect(elements['progress-percent'].textContent).to.equal('Working…');
        expect(elements['activity-panel'].scrolled).to.equal(true);
        expect(elements['activity-panel'].hidden).to.equal(false);
        expect(elements['sync-now'].disabled).to.equal(true);

        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'ok', detail: 'Sync complete' } });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(elements['progress-percent'].textContent).not.to.equal('100%');
        expect(elements.loader.style.display).to.equal('none');
        expect(elements.status.style.display).to.equal('block');
        expect(elements.status.textContent).to.equal('Sync complete');
        expect(elements.status.className).to.equal('ok');
    });
    it('streams literal file names, follows output and preserves manual scrolling', () => {
        elements['dry-run'].click();
        const log = elements['activity-log'];
        windowStub.postMessageToListeners({ data: { command: 'syncLog', text: 'PLAN UPLOAD: <script>.txt\n' } });
        expect(log.textContent).to.include('<script>.txt');
        expect(log.children.every((child) => child.children.length === 0)).to.equal(true);
        expect(log.scrollTop).to.equal(log.scrollHeight);
        log.scrollHeight = 2000;
        log.scrollTop = 0;
        windowStub.postMessageToListeners({ data: { command: 'syncLog', text: 'next file\n' } });
        expect(log.scrollTop).to.equal(0);
        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'error', detail: 'Connection lost' } });
        expect(log.textContent).to.include('ERROR: Connection lost');
        expect(elements['sync-now'].disabled).to.equal(false);
        expect(elements['dry-run'].disabled).to.equal(false);
    });

    it('prevents duplicate runs and clears the previous log on a new run', () => {
        elements['sync-now'].click();
        elements['dry-run'].click();
        expect(messages.filter((message) => ['sync', 'dryRun'].includes(message.command))).to.have.length(1);
        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'ok', detail: 'Old result' } });
        elements['dry-run'].click();
        expect(elements['activity-log'].textContent).not.to.include('Old result');
        expect(messages).to.deep.include({ command: 'dryRun' });
        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'ok', detail: 'Preview done' } });
    });

    it('shows Cancel only during a transfer and sends the cancel request', () => {
        expect(elements['cancel-transfer'].hidden).to.equal(true);

        elements['sync-now'].click();
        expect(elements['cancel-transfer'].hidden).to.equal(false);
        expect(elements['cancel-transfer'].disabled).to.equal(false);

        elements['cancel-transfer'].click();
        expect(messages).to.deep.include({ command: 'cancel' });
        expect(elements['cancel-transfer'].disabled).to.equal(true);

        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'error', detail: 'Transfer cancelled' } });
        expect(elements['cancel-transfer'].hidden).to.equal(true);
    });

    it('restores real progress and colored logs, then requests fresh state on focus', () => {
        const state = { id: 'task', status: 'running', phase: 'Transferring files', percent: 45,
            current: 9, total: 20, completedBytes: 90, totalBytes: 200, localFiles: 0, remoteFiles: 20,
            directories: 3, uploadMs: 125, downloadMs: 75, elapsedMs: 2000, file: 'x.txt',
            logs: ['DOWNLOAD x.txt — started\n', 'DOWNLOAD y.txt — done\n'] };
        windowStub.postMessageToListeners({ data: { command: 'syncState', state } });
        expect(elements['progress-percent'].textContent).to.include('45%');
        expect(elements['progress-percent'].textContent).to.include('Upload: 125 ms');
        expect(elements['progress-percent'].textContent).to.include('Download: 75 ms');
        expect(elements['progress-percent'].textContent).to.include('Session: 2.00 s');
        expect(elements['sync-now'].disabled).to.equal(true);
        expect(elements['activity-log'].children.map((line) => line.className)).to.deep.equal(['log-started', 'log-done']);
        (windowListeners.focus || []).forEach((listener) => listener());
        expect(messages).to.deep.include({ command: 'getSyncState' });
        windowStub.postMessageToListeners({ data: { command: 'syncState', state: { ...state, status: 'error', result: 'Connection lost' } } });
        expect(elements['progress-percent'].textContent).to.include('45%');
        expect(elements.status.textContent).to.equal('Connection lost');
        expect(elements['sync-now'].disabled).to.equal(false);
    });

});
