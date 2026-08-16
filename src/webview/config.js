const vscode = acquireVsCodeApi(),
    fields = [
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
    ],
    loader = document.getElementById('loader'),
    progressBar = document.getElementById('progress-bar'),
    progressPercent = document.getElementById('progress-percent'),
    statusEl = document.getElementById('status');
let progressInterval = null;

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
    const passwordEl = document.getElementById('password'),
        useTeleport = document.getElementById('useTeleport');
    if (passwordEl && passwordEl.value.trim() === '') {
        config.password = undefined;
    }
    config.useTeleport = useTeleport ? useTeleport.checked : true;
    return config;
}

function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type || '';
}

function updateProgress(percent) {
    const count = Math.round(percent / 5);
    const blocks = progressBar.children;
    for (let i = 0; i < blocks.length; i++) {
        blocks[i].classList.toggle('active', i < count);
    }
    progressPercent.textContent = percent + '%';
}

function startProgress() {
    if (progressInterval) { clearInterval(progressInterval); }
    loader.style.display = 'block';
    statusEl.style.display = 'none';
    progressBar.innerHTML = '';
    for (let i = 0; i < 20; i++) {
        const b = document.createElement('div');
        b.className = 'progress-block';
        progressBar.appendChild(b);
    }
    let percent = 0;
    updateProgress(0);
    progressInterval = setInterval(() => {
        percent += 1;
        if (percent > 95) { percent = 95; }
        updateProgress(percent);
    }, 100);
}

function stopProgress() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    updateProgress(100);
    setTimeout(() => {
        loader.style.display = 'none';
        statusEl.style.display = 'block';
    }, 250);
}

document.getElementById('config-form').addEventListener('submit', (event) => {
    event.preventDefault();
    startProgress();
    vscode.postMessage({ command: 'save', config: readConfig() });
});

document.getElementById('teleport-login').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'login' });
});

document.getElementById('test-teleport').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'test' });
});

document.getElementById('dry-run').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'dryRun' });
});

document.getElementById('sync-now').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'sync' });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
        case 'load':
            loadConfig(message.config);
            break;
        case 'saved':
            stopProgress();
            setStatus('Configuration saved', 'ok');
            break;
        case 'loginResult':
        case 'testResult':
        case 'syncResult':
            stopProgress();
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
