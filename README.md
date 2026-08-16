# FTP / SFTP / Teleport Sync for VS Code

A single VS Code extension that keeps your local project folder in sync with a remote host — no matter which transport your team or server uses. Pick **FTP**, **SFTP over SSH**, or **Teleport (`tsh`)**, fill the visual configuration panel, and let the extension handle the rest: secure credential storage, incremental transfers, upload-on-save, continuous watching, dry-run preview, and status-bar feedback.

## Why this plugin

Most teams end up with a mix of remote environments: legacy boxes that only speak FTP, modern cloud hosts reachable over plain SSH/SFTP, and corporate infrastructure locked behind Teleport. This extension replaces multiple tools and manual `rsync`/`lftp` commands with one consistent workflow inside VS Code.

- **One UI, three transports.** Switch between FTP, SFTP, and Teleport from a dropdown. The last selected mode is remembered.
- **Visual config panel.** No need to hand-edit `settings.json`; the `SFTP: Open Configuration` webview writes all fields to your global IDE settings when you click **Save**.
- **Incremental sync.** Uses `rsync` for SFTP/Teleport and `lftp mirror` for FTP, transferring only changed files.
- **Upload on save.** Optionally upload the whole `localPath` after every manual `Ctrl+S` or auto-save.
- **Continuous watching.** Run `SFTP: Start Watching` to sync automatically when files change, with a configurable debounce.
- **Dry run.** Preview what would happen without changing the remote side.
- **Secure credentials.** Passwords are stored in VS Code `SecretStorage`; only configuration values live in `settings.json`.
- **Status bar.** Always see the current state: `logging in`, `syncing`, `watching`, `ready`, or `error`.
- **One active configuration.** The extension keeps a single configuration at a time. To switch to a different server or mode, click **Delete Config** in the webview and save a new one. Your password stays in VS Code `SecretStorage` until you overwrite it.
- **No custom shell glue.** Unlike a hand-rolled VS Code Task or a `bash`/`python` watcher, this plugin uses `rsync`/`lftp` directly with secure secret handling, live status feedback, and first-class Teleport support out of the box.

## Why not a VS Code Task or shell script

A common Debian / VS Code workaround is a Task that runs an external script to watch files and `rsync` them. That works, but it leaves several problems unsolved:

- **Security.** A Task or script almost always stores credentials in plain text inside a repo file, `.env`, or a shell alias. This extension stores passwords in VS Code `SecretStorage` and keeps `settings.json` free of secrets.
- **Maintenance.** Tasks are usually per-workspace and require you to write, debug, and copy a shell script across machines and OSes.
- **No live status.** A background script has no UI. You do not see whether it is currently logging in, syncing, or failing without digging through a terminal panel.
- **No dry-run / on-demand sync.** The extension gives you a one-click dry run, manual sync, and automatic upload on save or file watcher.
- **No Teleport integration.** Teleport's `tsh login` flow, session cache, and browser link handling would have to be implemented manually.
- **Cross-platform.** `rsync` paths, `lftp` quoting, and `ssh` flag differences vary between macOS, Linux, and WSL. The plugin already normalizes these for FTP, SFTP, and Teleport modes.

## What you need

- Visual Studio Code 1.80+ or Devin Desktop
- One of the following transport clients in your `$PATH`:
  - **Teleport mode:** `tsh` and `rsync`
  - **SFTP mode:** `rsync` and `ssh`
  - **FTP mode:** `lftp`

## How it works

1. **Activation.** The extension activates on `onStartupFinished` and reads the `sftpPluggin.*` settings.
2. **Mode selection.** `sftpPluggin.mode` is `ftp`, `sftp`, or `teleport`. The webview sets and persists this value.
3. **Connection ready-up.**
   - **Teleport:** the extension runs `tsh status`; if the session is missing or expired it runs `tsh login --proxy=<teleportHost> --user=<teleportUser> [--cluster=<teleportCluster>]`, captures the browser link, and opens it with `vscode.env.openExternal`.
   - **SFTP:** `rsync` is invoked through an `ssh` tunnel (optionally using an identity file and extra SSH flags).
   - **FTP:** `lftp` is invoked with `mirror -R` to push the local tree to the remote path.
4. **Transfer.** Depending on the mode the extension runs the equivalent of:
   - `rsync -avz --delete <localPath>/ <sftpUser>@<sftpHost>:<remotePath>/` (SFTP / Teleport)
   - `lftp -c "open -u <ftpUser>,<password> <ftpHost>; mirror -R ... <localPath> <remotePath>"` (FTP)
5. **Upload on save.** `onDidSaveTextDocument` triggers a sync for files inside `localPath` when `uploadOnSave` or `uploadOnAutoSave` is enabled.
6. **File watcher.** `SFTP: Start Watching` watches `localPath/**` and syncs after `debounceMs`.
7. **Status bar.** The status bar shows the current operation and result.

## Install the extension

1. Build or download `sftp-pluggin.vsix`.
2. Open VS Code / Devin Desktop.
3. Go to the **Extensions** view.
4. Click the `...` menu and choose **Install from VSIX...**.
5. Select the `.vsix` file.

## Full configuration reference

All settings live under `sftpPluggin`. You can set them through `Settings` (`Cmd/Ctrl+,`), the `SFTP: Open Configuration` webview, or by editing user `settings.json`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sftpPluggin.mode` | `string` | `teleport` | Transport mode: `ftp`, `sftp`, `teleport`. Inferred from `useTeleport` for existing configs. |
| `sftpPluggin.teleportHost` | `string` | `undefined` | Teleport proxy host, e.g. `teleport.example.com` |
| `sftpPluggin.teleportUser` | `string` | `undefined` | Your Teleport username |
| `sftpPluggin.teleportCluster` | `string` | `undefined` | Teleport cluster name, e.g. `main` |
| `sftpPluggin.sftpHost` | `string` | `undefined` | Target SSH/SFTP host (also used as the Teleport target) |
| `sftpPluggin.sftpUser` | `string` | `undefined` | Username on the target host |
| `sftpPluggin.ftpHost` | `string` | `undefined` | FTP server host, e.g. `ftp.example.com` |
| `sftpPluggin.ftpUser` | `string` | `undefined` | FTP username |
| `sftpPluggin.remotePath` | `string` | `undefined` | Destination directory on the remote host, e.g. `/home/user/project` |
| `sftpPluggin.localPath` | `string` | `undefined` | Local directory to sync from; can be absolute or relative to the first workspace folder |
| `sftpPluggin.identity` | `string` | `undefined` | SSH private key path, used only in `sftp` mode |
| `sftpPluggin.password` | `string` | `undefined` | Stored in VS Code `SecretStorage`; used for FTP login and hidden from `settings.json` |
| `sftpPluggin.debounceMs` | `number` | `300` | Milliseconds to wait after a watcher event before syncing |
| `sftpPluggin.rsyncFlags` | `string` | `undefined` | Extra rsync flags for `sftp`/`teleport` modes, e.g. `--exclude .git --checksum` |
| `sftpPluggin.sshFlags` | `string` | `undefined` | Extra SSH flags for `sftp` mode, e.g. `-p 2222` |
| `sftpPluggin.uploadOnSave` | `boolean` | `true` | Upload the saved file's tree after a manual `Ctrl+S` |
| `sftpPluggin.uploadOnAutoSave` | `boolean` | `false` | Upload the saved file's tree after VS Code auto-save |

## Sample `settings.json`

### Teleport

```json
{
  "sftpPluggin.mode": "teleport",
  "sftpPluggin.teleportHost": "teleport.example.com",
  "sftpPluggin.teleportUser": "your-teleport-user",
  "sftpPluggin.teleportCluster": "main",
  "sftpPluggin.sftpHost": "sftp-node",
  "sftpPluggin.sftpUser": "your-sftp-user",
  "sftpPluggin.remotePath": "/home/your-sftp-user/project",
  "sftpPluggin.localPath": "${workspaceFolder}/project",
  "sftpPluggin.debounceMs": 300,
  "sftpPluggin.rsyncFlags": "--exclude .git --exclude node_modules",
  "sftpPluggin.uploadOnSave": true,
  "sftpPluggin.uploadOnAutoSave": false
}
```

### SFTP over SSH

```json
{
  "sftpPluggin.mode": "sftp",
  "sftpPluggin.sftpHost": "sftp.example.com",
  "sftpPluggin.sftpUser": "deploy",
  "sftpPluggin.identity": "~/.ssh/id_rsa",
  "sftpPluggin.sshFlags": "-p 2222",
  "sftpPluggin.remotePath": "/var/www/project",
  "sftpPluggin.localPath": "${workspaceFolder}",
  "sftpPluggin.rsyncFlags": "--exclude .git --exclude node_modules",
  "sftpPluggin.uploadOnSave": true
}
```

### FTP

```json
{
  "sftpPluggin.mode": "ftp",
  "sftpPluggin.ftpHost": "ftp.example.com",
  "sftpPluggin.ftpUser": "deploy",
  "sftpPluggin.remotePath": "/public_html/project",
  "sftpPluggin.localPath": "${workspaceFolder}",
  "sftpPluggin.uploadOnSave": true
}
```

## Step-by-step usage

1. Open `SFTP: Open Configuration` from the Command Palette.
2. Select the transport mode from the **Connection Mode** dropdown and fill the visible fields.
3. Click **Save**. All values are written to your global `settings.json` automatically.
4. Use **Login to Teleport** / **Test Teleport** when in `teleport` mode, or jump straight to **Dry Run** / **Sync Now**.
5. Press `Ctrl+S` in any file inside `localPath` to trigger an automatic upload.
6. To auto-upload on every change, run `SFTP: Start Watching`.
7. To switch to a different server or mode, click **Delete Config** in the webview, then save a new configuration. The stored password is preserved unless you overwrite it.

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

The test suite covers command building for all three modes, configuration validation, the webview UI interaction, the progress renderer, and the `saveConfiguration` flow that writes every GUI field to the global settings.

## Notes on the Teleport session

A Teleport session is valid for about 10 hours. The extension checks the session before every sync, so when it expires the next `Ctrl+S`, `Sync Now`, or watcher-triggered sync automatically starts `tsh login` again and opens the browser. You only need to authenticate again in the browser.

## Security

- Configuration is stored in `settings.json` and is safe to share and version-control (no secrets).
- Passwords are stored in VS Code `SecretStorage` and never appear in `settings.json`.
- The `password` field in the webview is a secret input; leaving it empty keeps the existing stored password.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
