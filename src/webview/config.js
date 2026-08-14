const vscode = acquireVsCodeApi();

const fields = [
    'teleportHost',
    'teleportUser',
    'teleportCluster',
    'sftpHost',
    'sftpUser',
    'remotePath',
    'localPath',
    'identity',
    'password',
    'debounceMs'
];

function loadConfig(config) {
    for (const field of fields) {
        const el = document.getElementById(field);
        if (el) {
            const value = config[field];
            el.value = value !== undefined && value !== null ? String(value) : '';
        }
    }
    const useTeleport = document.getElementById('useTeleport');
    if (useTeleport) {
        useTeleport.checked = config.useTeleport !== undefined ? Boolean(config.useTeleport) : true;
    }
}

function readConfig() {
    const config = {};
    for (const field of fields) {
        const el = document.getElementById(field);
        if (el) {
            config[field] = el.value;
        }
    }
    const passwordEl = document.getElementById('password');
    if (passwordEl && passwordEl.value.trim() === '') {
        config.password = undefined;
    }
    const useTeleport = document.getElementById('useTeleport');
    config.useTeleport = useTeleport ? useTeleport.checked : true;
    return config;
}

function setStatus(text, type) {
    const s = document.getElementById('status');
    s.textContent = text;
    s.className = type || '';
}

document.getElementById('config-form').addEventListener('submit', (event) => {
    event.preventDefault();
    vscode.postMessage({ command: 'save', config: readConfig() });
});

document.getElementById('teleport-login').addEventListener('click', () => {
    setStatus('Teleport login in progress... open your browser when prompted');
    vscode.postMessage({ command: 'login' });
});

document.getElementById('test-teleport').addEventListener('click', () => {
    setStatus('Testing Teleport...');
    vscode.postMessage({ command: 'test' });
});

document.getElementById('dry-run').addEventListener('click', () => {
    setStatus('Dry run in progress...');
    vscode.postMessage({ command: 'dryRun' });
});

document.getElementById('sync-now').addEventListener('click', () => {
    setStatus('Sync in progress...');
    vscode.postMessage({ command: 'sync' });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
        case 'load':
            loadConfig(message.config);
            break;
        case 'saved':
            setStatus('Configuration saved', 'ok');
            break;
        case 'loginResult':
        case 'testResult':
        case 'syncResult':
            setStatus(message.detail, message.status);
            break;
    }
});

function notifyReady() {
    vscode.postMessage({ command: 'ready' });
}

if (document.readyState !== 'loading') {
    notifyReady();
} else {
    window.addEventListener('DOMContentLoaded', notifyReady);
}
