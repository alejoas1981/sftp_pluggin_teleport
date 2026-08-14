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
        if (el && config[field] !== undefined) {
            el.value = config[field];
        }
    }
    const useTeleport = document.getElementById('useTeleport');
    if (useTeleport && config.useTeleport !== undefined) {
        useTeleport.checked = config.useTeleport;
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
        case 'testResult':
        case 'syncResult':
            setStatus(message.detail, message.status);
            break;
    }
});

vscode.postMessage({ command: 'ready' });
