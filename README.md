# SFTP Plugin for VS Code (Teleport)

A VS Code extension that synchronizes a local project folder to a remote host over `rsync` through a Teleport (`tsh`) tunnel.
It handles browser-based SSO login, incremental upload on save, optional auto-save upload, continuous file watching, dry-run preview, and status-bar feedback.

## What you need

- Visual Studio Code 1.80+ or Devin Desktop
- `tsh` (Teleport client) installed and in `$PATH`
- `rsync` installed (macOS and Linux include it by default)
- A Teleport cluster with access to the target SSH/SFTP host

## How it works

1. **Activation.** The extension activates on `onStartupFinished`. It immediately reads the `sftpPluggin.*` settings.
2. **Auto-login.** On startup (and before every sync), the extension runs `tsh status`.
   - If the Teleport session is active (inside the ~10 hour lifetime), it proceeds.
   - If the session is missing or expired, it runs `tsh login --proxy=<teleportHost> --user=<teleportUser> [--cluster=<teleportCluster>]`, captures the browser link from `stdout`/`stderr`, and opens it via `vscode.env.openExternal`. You authenticate in the browser (login, password, Microsoft Authenticator/2FA code). When `tsh` receives the certificate, the sync proceeds.
3. **Upload on save.** The extension listens to `vscode.workspace.onWillSaveTextDocument` and `onDidSaveTextDocument` to determine the save reason (`Manual`, `AfterDelay`, `FocusOut`).
   - `sftpPluggin.uploadOnSave` (default `true`) controls upload after `Ctrl+S`.
   - `sftpPluggin.uploadOnAutoSave` (default `false`) controls upload after VS Code auto-save.
4. **Rsync transfer.** With Teleport enabled the extension sets `RSYNC_RSH="tsh ssh --cluster=<cluster>"` and runs:
   ```bash
   rsync -avz --delete <localPath>/ <sftpUser>@<sftpHost>:<remotePath>/
   ```
   `rsync` transfers only changed blocks/files, so repeated uploads are fast.
5. **File watcher.** `SFTP: Start Watching` creates a `vscode.FileSystemWatcher` over `localPath/**`. On each change it debounces for `debounceMs` and then runs the same sync logic, automatically re-logging in if the Teleport session expired.
6. **Status bar.** A `StatusBarItem` shows the current state: `logging in`, `syncing`, `watching`, `ready`, or `error`.

## Install the extension

1. Take the built file `sftp-pluggin-0.0.1.vsix`.
2. Open VS Code / Devin Desktop.
3. Go to the **Extensions** view.
4. Click the `...` menu and choose **Install from VSIX...**.
5. Select `sftp-pluggin-0.0.1.vsix`.

## Full configuration reference

All settings live under the `sftpPluggin` namespace. You can set them via `Settings` (`Cmd/Ctrl+,`), the webview (`SFTP: Open Configuration`), or by editing `.vscode/settings.json` / user `settings.json`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sftpPluggin.teleportHost` | `string` | `undefined` | Teleport proxy host, e.g. `teleport.example.com` |
| `sftpPluggin.teleportUser` | `string` | `undefined` | Your Teleport username, e.g. `your-teleport-user` |
| `sftpPluggin.teleportCluster` | `string` | `undefined` | Teleport cluster name, e.g. `main` |
| `sftpPluggin.sftpHost` | `string` | `undefined` | Target host inside Teleport, e.g. `sftp-node` |
| `sftpPluggin.sftpUser` | `string` | `undefined` | Username on the target host |
| `sftpPluggin.remotePath` | `string` | `undefined` | Destination directory on the remote host, e.g. `/home/user/project` |
| `sftpPluggin.localPath` | `string` | `undefined` | Local directory to sync from; can be absolute or relative to the first workspace folder |
| `sftpPluggin.identity` | `string` | `undefined` | SSH private key path, used only when `useTeleport` is `false` |
| `sftpPluggin.password` | `string` | `undefined` | Stored in VS Code `SecretStorage`; not used when Teleport is enabled |
| `sftpPluggin.debounceMs` | `number` | `300` | Milliseconds to wait after a watcher event before syncing |
| `sftpPluggin.useTeleport` | `boolean` | `true` | Whether to tunnel rsync through `tsh ssh` |
| `sftpPluggin.rsyncFlags` | `string` | `undefined` | Extra rsync flags, e.g. `--exclude .git --checksum` |
| `sftpPluggin.sshFlags` | `string` | `undefined` | Extra SSH flags for non-Teleport mode |
| `sftpPluggin.uploadOnSave` | `boolean` | `true` | Upload the saved file after a manual `Ctrl+S` |
| `sftpPluggin.uploadOnAutoSave` | `boolean` | `false` | Upload the saved file after VS Code auto-save (`files.autoSave` must be enabled) |

## Sample `.vscode/settings.json`

```json
{
  "sftpPluggin.teleportHost": "teleport.example.com",
  "sftpPluggin.teleportUser": "your-teleport-user",
  "sftpPluggin.teleportCluster": "main",
  "sftpPluggin.sftpHost": "sftp-node",
  "sftpPluggin.sftpUser": "your-sftp-user",
  "sftpPluggin.remotePath": "/home/your-sftp-user/project",
  "sftpPluggin.localPath": "${workspaceFolder}/project",
  "sftpPluggin.debounceMs": 300,
  "sftpPluggin.useTeleport": true,
  "sftpPluggin.rsyncFlags": "--exclude .git --exclude node_modules",
  "sftpPluggin.uploadOnSave": true,
  "sftpPluggin.uploadOnAutoSave": false
}
```

## Step-by-step usage

1. Open `SFTP: Open Configuration` from the Command Palette, fill the form, and click **Save**.
2. Press `Ctrl+S` or run `SFTP: Sync Now`.
   - If the Teleport session is not active, a browser link opens.
   - Log in through the browser (login, password, Microsoft Authenticator/2FA code).
   - The extension confirms `Teleport login successful`.
3. The file is uploaded with `rsync`.
4. From now on `Ctrl+S` in any file inside `localPath` uploads the project automatically.
5. To upload on VS Code auto-save, enable `files.autoSave` and set `sftpPluggin.uploadOnAutoSave` to `true`.
6. To sync on every file change without saving, run `SFTP: Start Watching`.

## Commands

- `SFTP: Open Configuration`
- `SFTP: Teleport Login`
- `SFTP: Test Teleport Connection`
- `SFTP: Sync Now`
- `SFTP: Dry Run`
- `SFTP: Start Watching`
- `SFTP: Stop Watching`

## Testing

```bash
npm test
```

## Notes on the Teleport session

A Teleport session is valid for about 10 hours. The extension checks the session before every sync, so when it expires, the next `Ctrl+S`, `Sync Now`, or watcher-triggered sync automatically starts `tsh login` again and opens the browser. You only need to authenticate again in the browser.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
