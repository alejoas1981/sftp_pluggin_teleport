const vscode = acquireVsCodeApi(),
    settingsLinkEl = document.getElementById('settings-link'),
    fields = [
        'mode',
        'teleportHost',
        'teleportUser',
        'teleportCluster',
        'sftpHost',
        'sftpUser',
        'sftpPort',
        'ftpHost',
        'ftpUser',
        'ftpPort',
        'remotePath',
        'localPath',
        'identity',
        'debounceMs',
        'sshFlags',
        'rsyncFlags'
    ],
    loader = document.getElementById('loader'),
    progressBar = document.getElementById('progress-bar'),
    progressPercent = document.getElementById('progress-percent'),
    statusEl = document.getElementById('status');
let progressInterval = null;

/**
 * Loads configuration values into the webview form fields.
 * @param {Object} config - The configuration object.
 * @returns {void}
 */
function loadConfig(config) {
    for (const field of fields) {
        const el = document.getElementById(field);
        if (el) {
            let value = config[field];
            if ((field === 'ftpPort' || field === 'sftpPort') && (value === 0 || value === '0' || value === undefined || value === null)) {
                value = field === 'sftpPort' ? 22 : 21;
            }
            el.value = value !== undefined && value !== null ? String(value) : '';
        }
    }
    const passwordEl = document.getElementById('password'),
        useRsyncEl = document.getElementById('useRsync'),
        savePasswordEl = document.getElementById('save-password');
    if (passwordEl) { passwordEl.value = ''; }
    if (useRsyncEl) { useRsyncEl.checked = !!config.useRsync; }
    if (savePasswordEl) { savePasswordEl.checked = false; }
    updateModeFields();
}

/**
 * Reads the current values from the webview form.
 * @returns {Object} The configuration object.
 */
function readConfig() {
    const config = {};
    for (const field of fields) {
        const el = document.getElementById(field);
        if (el) {
            if (field === 'debounceMs') {
                config[field] = Number(el.value) || 300;
            } else if (field === 'sftpPort' || field === 'ftpPort') {
                const defaultPort = field === 'sftpPort' ? 22 : 21;
                config[field] = el.value.trim() === '' || Number.isNaN(Number(el.value)) ? defaultPort : Number(el.value);
            } else {
                config[field] = el.value;
            }
        }
    }
    const passwordEl = document.getElementById('password'),
        savePasswordEl = document.getElementById('save-password'),
        useRsyncEl = document.getElementById('useRsync');
    if (passwordEl && passwordEl.value === '********') {
        config.password = undefined;
    } else if (passwordEl && passwordEl.value.trim() === '') {
        config.password = '';
    } else if (passwordEl) {
        config.password = passwordEl.value;
    }
    config.savePassword = savePasswordEl ? savePasswordEl.checked : false;
    config.useRsync = useRsyncEl ? useRsyncEl.checked : false;
    return config;
}

const titles = {
    ftp: 'FTP Config',
    sftp: 'SFTP Config',
    teleport: 'Teleport Config'
};

/**
 * Updates the visibility and disabled state of form fields based on the selected mode.
 * @returns {void}
 */
function updateModeFields() {
    const mode = document.getElementById('mode').value,
        nodes = document.querySelectorAll('[data-mode]');
    for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i],
            modes = (el.getAttribute('data-mode') || '').split(',').map(m => m.trim());
        if (modes.indexOf(mode) >= 0) {
            el.classList.remove('hidden');
            el.style.display = '';
            el.disabled = false;
        } else {
            el.classList.add('hidden');
            el.style.display = 'none';
            el.disabled = true;
        }
    }
    const titleEl = document.querySelector('h1');
    if (titleEl) {
        titleEl.textContent = titles[mode] || 'FTP SFTP Teleport Config';
    }
    document.title = titles[mode] || 'FTP SFTP Teleport Config';
}

/**
 * Sets the status message and CSS class.
 * @param {string} text - The status text.
 * @param {string} type - The status type class.
 * @returns {void}
 */
function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type || '';
}

/**
 * Displays a link to open the workspace settings.json file.
 * @param {string} settingsPath - The path to settings.json.
 * @returns {void}
 */
function showSettingsLink(settingsPath) {
    if (!settingsLinkEl) { return; }
    settingsLinkEl.style.display = 'block';
    settingsLinkEl.innerHTML = '';
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = 'Open settings.json';
    a.style.color = 'var(--vscode-textLink-foreground)';
    a.style.textDecoration = 'underline';
    a.style.cursor = 'pointer';
    a.addEventListener('click', (event) => {
        event.preventDefault();
        vscode.postMessage({ command: 'openFile', path: settingsPath });
    });
    settingsLinkEl.appendChild(a);
}

/**
 * Updates the progress bar fill and percentage text.
 * @param {number} percent - The completion percentage.
 * @returns {void}
 */
function updateProgress(percent) {
    const count = Math.round(percent / 5),
        blocks = progressBar.children;
    for (let i = 0; i < blocks.length; i++) {
        blocks[i].classList.toggle('active', i < count);
    }
    progressPercent.textContent = percent + '%';
}

/**
 * Starts the loading progress bar animation.
 * @returns {void}
 */
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

/**
 * Stops the progress bar and hides the loader after a short delay.
 * @returns {void}
 */
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

document.getElementById('mode').addEventListener('change', () => {
    updateModeFields();
});

document.getElementById('teleport-login').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'login' });
});

document.getElementById('test-connection').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'test', config: readConfig() });
});

document.getElementById('dry-run').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'dryRun' });
});

document.getElementById('sync-now').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'sync' });
});

document.getElementById('delete-config').addEventListener('click', () => {
    const mode = document.getElementById('mode').value;
    vscode.postMessage({ command: 'deleteConfig', mode });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
        case 'load':
            loadConfig(message.config);
            const modeEl = document.getElementById('mode');
            if (modeEl) { modeEl.disabled = !!message.hasSavedConfig; }
            if (message.hasPassword) {
                const passwordEl = document.getElementById('password'),
                    savePasswordEl = document.getElementById('save-password');
                if (passwordEl) { passwordEl.value = '********'; }
                if (savePasswordEl) { savePasswordEl.checked = true; }
            }
            break;
        case 'saved':
            stopProgress();
            setStatus('Configuration saved', 'ok');
            if (message.settingsPath) { showSettingsLink(message.settingsPath); }
            break;
        case 'error':
            stopProgress();
            setStatus(message.detail, 'error');
            break;
        case 'loginResult':
        case 'testResult':
        case 'syncResult':
            stopProgress();
            setStatus(message.detail, message.status);
            break;
        case 'deleted':
            loadConfig({ mode: 'ftp', ftpPort: 21, sftpPort: 22, debounceMs: 300 });
            const modeElAfterDelete = document.getElementById('mode');
            if (modeElAfterDelete) { modeElAfterDelete.disabled = false; }
            if (settingsLinkEl) { settingsLinkEl.style.display = 'none'; }
            setStatus('Configuration deleted', 'ok');
            break;
    }
});

/**
 * Notifies the extension that the webview is ready.
 * @returns {void}
 */
function notifyReady() {
    vscode.postMessage({ command: 'ready' });
}

document.getElementById('password').addEventListener('focus', function () {
    if (this.value === '********') { this.select(); }
});

if (document.readyState !== 'loading') {
    notifyReady();
} else {
    window.addEventListener('DOMContentLoaded', notifyReady);
}
