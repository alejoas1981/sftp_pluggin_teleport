import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

interface FakeElement {
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
        expect(elements['progress-percent'].textContent).to.equal('3%');
        expect(elements['progress-bar'].children[0].classList.list.has('active')).to.be.true;

        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'ok', detail: 'Sync complete' } });

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(elements['progress-percent'].textContent).to.equal('100%');
        expect(elements.loader.style.display).to.equal('none');
        expect(elements.status.style.display).to.equal('block');
        expect(elements.status.textContent).to.equal('Sync complete');
        expect(elements.status.className).to.equal('ok');
    });
});
