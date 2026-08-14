document.getElementById('config-form').addEventListener('submit', function(event) {
    event.preventDefault();
    const host = document.getElementById('host').value;
    const user = document.getElementById('user').value;
    const remotePath = document.getElementById('remote-path').value;
    
    // Send data back to the extension
    window.acquireVsCodeApi().postMessage({
        command: 'saveConfig',
        data: { host, user, remotePath }
    });
});