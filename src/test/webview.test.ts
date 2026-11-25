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
        get firstChild() { return children[0]; },
        removeChild: (child: FakeElement) => { children.splice(children.indexOf(child), 1); },
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

    it('loads and saves both automatic upload preferences in the panel', () => {
        windowStub.postMessageToListeners({ data: { command: 'load', config: {
            mode: 'teleport', uploadOnSave: false, uploadOnAutoSave: true
        }, hasSavedConfig: true } });
        expect(elements.uploadOnSave.checked).to.equal(false);
        expect(elements.uploadOnAutoSave.checked).to.equal(true);
        expect(elements.mode.disabled).to.equal(false);
        elements.uploadOnSave.checked = true;
        elements.uploadOnAutoSave.checked = false;
        elements['config-form']._listeners.submit[0]({ preventDefault: () => {} });
        const save = messages.find((message) => message.command === 'save');
        expect(save.config.uploadOnSave).to.equal(true);
        expect(save.config.uploadOnAutoSave).to.equal(false);
    });

    it('shows loading bar and stops on result', async () => {
        const syncButton = elements['sync-now'];
        expect(syncButton).to.exist;

        syncButton.click();

        expect(elements.loader.style.display).to.equal('block');
        expect(elements['progress-bar'].children.length).to.equal(20);
        expect(messages).to.deep.include({ command: 'sync' });

        await new Promise((resolve) => setTimeout(resolve, 320));
        expect(elements['progress-percent'].textContent).to.equal('Working…');
        expect(elements['activity-panel'].scrolled).to.equal(true);
        expect(elements['activity-panel'].hidden).to.equal(false);
        expect(elements['sync-now'].disabled).to.equal(true);

        windowStub.postMessageToListeners({ data: { command: 'transferLog', start: 0, lines: [{ text: 'Sync complete', level: 'ok' }] } });
        windowStub.postMessageToListeners({ data: { command: 'testResult', status: 'ok' } });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(elements['progress-percent'].textContent).not.to.equal('100%');
        expect(elements.loader.style.display).to.equal('none');
        expect(elements['activity-log'].children[0].className).to.equal('log-done');
    });
    it('preserves history, renders literal output, and follows only from the bottom', () => {
        const send = (start: number, lines: { text: string; level?: string }[]) =>
                windowStub.postMessageToListeners({ data: { command: 'transferLog', start, lines } }),
            first = [{ text: '<script>.txt', level: 'ok' }, { text: 'Connection lost', level: 'error' }],
            log = elements['activity-log'];
        send(0, first);
        expect(log.textContent).to.equal('<script>.txt\nConnection lost\n');
        expect(log.children.every((child) => child.children.length === 0)).to.equal(true);
        expect(log.scrollTop).to.equal(log.scrollHeight);
        expect(log.children.map((child) => child.className)).to.deep.equal(['log-done', 'log-error']);
        log.scrollHeight = 2000;
        log.scrollTop = 30;
        send(0, [...first, { text: 'Cancelling', level: 'warning' }]);
        expect(log.children).to.have.length(3);
        expect(log.scrollTop).to.equal(30);
        expect(log.children[2].className).to.equal('log-warning');
        elements['sync-now'].click();
        elements['dry-run'].click();
        expect(messages.filter((message) => ['sync', 'dryRun'].includes(message.command))).to.have.length(1);
        expect(log.textContent).to.include('Connection lost');
        send(3, Array.from({ length: 1998 }, (_, i) => ({ text: `line ${i}` })));
        expect(log.children).to.have.length(2000);
        expect(log.children[0].textContent).to.equal('Connection lost\n');
        expect(log.children[1999].textContent).to.equal('line 1997\n');
    });
    it('shows Cancel only during a transfer and sends the cancel request', () => {
        expect(elements['cancel-transfer'].hidden).to.equal(true);

        elements['sync-now'].click();
        expect(elements['cancel-transfer'].hidden).to.equal(false);
        expect(elements['cancel-transfer'].disabled).to.equal(false);

        elements['cancel-transfer'].click();
        expect(messages).to.deep.include({ command: 'cancel' });
        expect(elements['cancel-transfer'].disabled).to.equal(true);

        windowStub.postMessageToListeners({ data: { command: 'syncState', state: { status: 'error', elapsedMs: 0 } } });
        expect(elements['cancel-transfer'].hidden).to.equal(true);
    });

    it('shows pending instead of zero transfer time while scanning', () => {
        const state = { id: 'scan', status: 'running', phase: 'Scanning remote files',
            current: 0, completedBytes: 0, localFiles: 34577, remoteFiles: 34209,
            directories: 7013, uploadMs: 0, downloadMs: 0, elapsedMs: 5960260,
            file: 'includes/example.php', logs: [] };
        windowStub.postMessageToListeners({ data: { command: 'syncState', state } });
        expect(elements['progress-percent'].textContent).to.include('Upload: pending');
        expect(elements['progress-percent'].textContent).to.include('Download: pending');
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
        windowStub.postMessageToListeners({ data: { command: 'transferLog', start: 0,
            lines: state.logs.map((text) => ({ text: text.trimEnd() })) } });
        expect(elements['activity-log'].children.map((line) => line.className)).to.deep.equal(['log-started', 'log-done']);
        (windowListeners.focus || []).forEach((listener) => listener());
        expect(messages).to.deep.include({ command: 'getSyncState' });
        windowStub.postMessageToListeners({ data: { command: 'syncState', state: { ...state, status: 'error', result: 'Connection lost' } } });
        expect(elements['progress-percent'].textContent).to.include('45%');
        expect(elements['sync-now'].disabled).to.equal(false);
    });

});

describe('Teleport configuration fields', () => {
    it('exposes the target host and user in Teleport mode', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'src/webview/config.html'), 'utf8');
        expect(html).to.match(/data-mode="sftp,teleport"><label for="sftpHost"/);
        expect(html).to.match(/data-mode="sftp,teleport"><label for="sftpUser"/);
    });
});
