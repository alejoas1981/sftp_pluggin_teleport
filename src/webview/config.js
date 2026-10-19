const vscode = acquireVsCodeApi(),
    settingsLinkEl = document.getElementById('settings-link'),
    teleportLoginEl = document.getElementById('teleport-login'),
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
        'privateKey',
        'passphrase',
        'agent',
        'concurrency',
        'scanConcurrency',
        'debounceMs',
        'rsyncFlags'
    ],
    loader = document.getElementById('loader'),
    progressBar = document.getElementById('progress-bar'),
    progressPercent = document.getElementById('progress-percent'),
    statusEl = document.getElementById('status'),
    activityPanel = document.getElementById('activity-panel'),
    activityLog = document.getElementById('activity-log');
let progressInterval = null, progressHideTimeout = null, syncRunning = false;

let activityLines = [];

function renderActivity() {
    const follow = activityLog.scrollHeight - activityLog.scrollTop - activityLog.clientHeight < 40;
    activityLog.textContent = '';
    for (const text of activityLines) {
        const line = document.createElement('span');
        line.className = text.includes(' — started') ? 'log-started' : text.includes(' — done') ? 'log-done'
            : text.includes(' — failed') || text.startsWith('ERROR:') ? 'log-error' : '';
        line.textContent = text;
        activityLog.appendChild(line);
    }
    if (follow) { activityLog.scrollTop = activityLog.scrollHeight; }
}

function appendActivity(text) {
    activityLines.push(text);
    activityLines = activityLines.slice(-500);
    renderActivity();
}

function renderSyncState(state) {
    if (!state) { return; }
    clearInterval(progressInterval);
    clearTimeout(progressHideTimeout);
    progressInterval = null;
    progressHideTimeout = null;
    setSyncRunning(state.status === 'running');
    activityPanel.hidden = false;
    loader.style.display = 'block';
    if (!progressBar.children.length) { createProgressBlocks(); }
    updateProgress(state.percent ?? 0);
    progressBar.classList.toggle('indeterminate', state.percent === undefined && syncRunning);
    progressPercent.textContent = `${state.phase} | ${state.percent === undefined ? 'Working…' : state.percent + '%'} | `
        + `Files: ${state.current}/${state.total ?? '?'} | Local: ${state.localFiles} | Remote: ${state.remoteFiles} | `
        + `Directories: ${state.directories} | Hash cache: ${state.cachedFiles ?? 0} reused / ${state.hashedFiles ?? 0} read | Completed file bytes: ${state.completedBytes}/${state.totalBytes ?? '?'} | `
        + `${Math.floor(state.elapsedMs / 1000)}s | ${state.file}`;
    activityLines = state.logs;
    renderActivity();
    if (state.result) { setStatus(state.result, state.status === 'complete' ? 'ok' : state.status); }
    if (state.progressReset) {
        updateProgress(0);
        progressBar.classList.remove('indeterminate');
        progressPercent.textContent = '';
        loader.style.display = 'none';
        setStatus('', '');
    }
}

function setSyncRunning(running) {
    syncRunning = running;
    for (const id of ['sync-now', 'dry-run', 'btn-save', 'delete-config', 'test-connection', 'teleport-login']) {
        document.getElementById(id).disabled = running;
    }
}

function startSync(command) {
    if (syncRunning) { return; }
    setSyncRunning(true);
    activityPanel.hidden = false;
    activityLines = [];
    activityLog.textContent = '';
    activityLog.scrollTop = 0;
    appendActivity(command === 'dryRun' ? 'Preparing preview…\n' : 'Preparing synchronization…\n');
    startProgress();
    clearInterval(progressInterval);
    progressInterval = null;
    progressPercent.textContent = 'Working…';
    activityPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    vscode.postMessage({ command });
}

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
        savePasswordEl = document.getElementById('save-password'),
        ignoreEl = document.getElementById('ignore'),
        ftpPassiveEl = document.getElementById('ftpPassive'),
        ftpSecureEl = document.getElementById('ftpSecure'),
        showUploadEl = document.getElementById('showUploadButton'),
        showDownloadEl = document.getElementById('showDownloadButton');
    if (passwordEl) { passwordEl.value = ''; }
    if (savePasswordEl) { savePasswordEl.checked = false; }
    if (ignoreEl) { ignoreEl.value = (config.ignore || []).join('\n'); }
    if (ftpPassiveEl) { ftpPassiveEl.checked = config.ftpPassive !== false; }
    if (ftpSecureEl) { ftpSecureEl.checked = !!config.ftpSecure; }
    document.getElementById('verifyContents').checked = !!config.verifyContents;
    if (showUploadEl) { showUploadEl.checked = config.showUploadButton === true; }
    if (showDownloadEl) { showDownloadEl.checked = config.showDownloadButton === true; }
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
            } else if (field === 'concurrency' || field === 'scanConcurrency') {
                config[field] = Number(el.value) || 4;
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
        ignoreEl = document.getElementById('ignore'),
        ftpPassiveEl = document.getElementById('ftpPassive'),
        ftpSecureEl = document.getElementById('ftpSecure'),
        showUploadEl = document.getElementById('showUploadButton'),
        showDownloadEl = document.getElementById('showDownloadButton');
    if (passwordEl && passwordEl.value === '********') {
        config.password = undefined;
    } else if (passwordEl && passwordEl.value.trim() === '') {
        config.password = '';
    } else if (passwordEl) {
        config.password = passwordEl.value;
    }
    config.savePassword = savePasswordEl ? savePasswordEl.checked : false;
    config.ftpPassive = ftpPassiveEl ? ftpPassiveEl.checked : true;
    config.ftpSecure = ftpSecureEl ? ftpSecureEl.checked : false;
    config.verifyContents = document.getElementById('verifyContents').checked;
    config.showUploadButton = showUploadEl ? showUploadEl.checked : false;
    config.showDownloadButton = showDownloadEl ? showDownloadEl.checked : false;
    if (ignoreEl) {
        config.ignore = ignoreEl.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    }
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
    settingsLinkEl.textContent = '';
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
    if (progressHideTimeout) { clearTimeout(progressHideTimeout); progressHideTimeout = null; }
    if (progressInterval) { clearInterval(progressInterval); }
    activityPanel.hidden = false;
    loader.style.display = 'block';
    if (!syncRunning) { loader.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    statusEl.style.display = 'none';
    createProgressBlocks();
    progressBar.classList.toggle('indeterminate', true);
    progressPercent.textContent = 'Working…';
}

function createProgressBlocks() {
    progressBar.textContent = '';
    for (let i = 0; i < 20; i++) {
        const block = document.createElement('div');
        block.className = 'progress-block';
        progressBar.appendChild(block);
    }
}

/**
 * Stops the progress bar and hides the loader after a short delay.
 * @returns {void}
 */
function stopProgress() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    progressBar.classList.toggle('indeterminate', false);
    progressHideTimeout = setTimeout(() => {
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

if (teleportLoginEl) {
    teleportLoginEl.addEventListener('click', () => {
        startProgress();
        vscode.postMessage({ command: 'login' });
    });
}

document.getElementById('test-connection').addEventListener('click', () => {
    startProgress();
    vscode.postMessage({ command: 'test', config: readConfig() });
});

document.getElementById('dry-run').addEventListener('click', () => {
    startSync('dryRun');
});

document.getElementById('sync-now').addEventListener('click', () => {
    startSync('sync');
});

document.getElementById('delete-config').addEventListener('click', () => {
    const mode = document.getElementById('mode').value;
    vscode.postMessage({ command: 'deleteConfig', mode });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
        case 'syncState':
            renderSyncState(message.state);
            break;
        case 'load':
            loadConfig(message.config);
            const modeEl = document.getElementById('mode');
            if (modeEl) { modeEl.disabled = !!message.hasSavedConfig; }
            if (teleportLoginEl) { teleportLoginEl.hidden = !!message.isLoggedIn; }
            if (message.hasPassword) {
                const passwordEl = document.getElementById('password'),
                    savePasswordEl = document.getElementById('save-password');
                if (passwordEl) { passwordEl.value = '********'; }
                if (savePasswordEl) { savePasswordEl.checked = true; }
            }
            break;
        case 'saved':
            stopProgress();
            setStatus('Configuration saved privately for this workspace', 'ok');
            if (message.settingsPath) { showSettingsLink(message.settingsPath); }
            break;
        case 'error':
            if (syncRunning) { appendActivity(`ERROR: ${message.detail}\n`); setSyncRunning(false); }
            stopProgress();
            setStatus(message.detail, 'error');
            break;
        case 'loginResult':
        case 'testResult':
            if (message.status === 'ok' && teleportLoginEl) { teleportLoginEl.hidden = true; }
            stopProgress();
            setStatus(message.detail, message.status);
            break;
        case 'syncLog':
            appendActivity(message.text);
            break;
        case 'syncResult':
            appendActivity(`${message.status === 'error' ? 'ERROR: ' : ''}${message.detail}\n`);
            setSyncRunning(false);
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

window.addEventListener('focus', () => vscode.postMessage({ command: 'getSyncState' }));
