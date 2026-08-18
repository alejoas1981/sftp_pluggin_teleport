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
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vm = __importStar(require("vm"));
/**
 * Creates a fake DOM element for testing the webview config panel.
 * @returns {FakeElement} A fake element with listener and child helpers.
 */
function createElement() {
    const listeners = {}, children = [], classes = new Set();
    const el = {
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
            toggle: (cls, force) => {
                if (force) {
                    classes.add(cls);
                }
                else {
                    classes.delete(cls);
                }
            }
        },
        addEventListener: (event, handler) => {
            listeners[event] = listeners[event] || [];
            listeners[event].push(handler);
        },
        appendChild: (child) => {
            children.push(child);
        },
        click: () => {
            (listeners.click || []).forEach((h) => h());
        }
    };
    Object.defineProperty(el, 'innerHTML', {
        get: () => '',
        set: (value) => {
            if (value === '') {
                children.length = 0;
            }
        }
    });
    return el;
}
describe('webview config panel', () => {
    const code = fs.readFileSync(path.join('src', 'webview', 'config.js'), 'utf8');
    let messages = [];
    const elements = {}, windowListeners = {};
    let windowStub;
    beforeEach(() => {
        messages = [];
        const documentStub = {
            readyState: 'loading',
            getElementById: (id) => {
                if (!elements[id]) {
                    elements[id] = createElement();
                }
                return elements[id];
            },
            querySelector: () => createElement(),
            querySelectorAll: () => [],
            createElement: () => createElement()
        };
        windowStub = {
            addEventListener: (event, handler) => {
                windowListeners[event] = windowListeners[event] || [];
                windowListeners[event].push(handler);
            },
            postMessageToListeners: (event) => {
                (windowListeners.message || []).forEach((h) => h(event));
            }
        };
        const sandbox = {
            document: documentStub,
            window: windowStub,
            acquireVsCodeApi: () => ({ postMessage: (msg) => messages.push(msg) }),
            setInterval: (fn, ms) => setInterval(fn, ms),
            clearInterval: (id) => clearInterval(id),
            setTimeout: (fn, ms) => setTimeout(fn, ms),
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
        (0, chai_1.expect)(syncButton).to.exist;
        syncButton.click();
        (0, chai_1.expect)(elements.loader.style.display).to.equal('block');
        (0, chai_1.expect)(elements.status.style.display).to.equal('none');
        (0, chai_1.expect)(elements['progress-bar'].children.length).to.equal(20);
        (0, chai_1.expect)(messages).to.deep.include({ command: 'sync' });
        await new Promise((resolve) => setTimeout(resolve, 320));
        (0, chai_1.expect)(elements['progress-percent'].textContent).to.equal('3%');
        (0, chai_1.expect)(elements['progress-bar'].children[0].classList.list.has('active')).to.be.true;
        windowStub.postMessageToListeners({ data: { command: 'syncResult', status: 'ok', detail: 'Sync complete' } });
        await new Promise((resolve) => setTimeout(resolve, 300));
        (0, chai_1.expect)(elements['progress-percent'].textContent).to.equal('100%');
        (0, chai_1.expect)(elements.loader.style.display).to.equal('none');
        (0, chai_1.expect)(elements.status.style.display).to.equal('block');
        (0, chai_1.expect)(elements.status.textContent).to.equal('Sync complete');
        (0, chai_1.expect)(elements.status.className).to.equal('ok');
    });
});
