# FTP / SFTP / Teleport Sync for VS Code

A single VS Code extension that keeps your local project folder in sync with a remote host — no matter which transport your team or server uses. Pick **FTP**, **SFTP over SSH**, or **Teleport (`tsh`)**, fill the visual configuration panel, and let the extension handle the rest: secure credential storage, incremental transfers, upload-on-save, continuous watching, dry-run preview, and status-bar feedback.

## Why this plugin

Most teams end up with a mix of remote environments: legacy boxes that only speak FTP, modern cloud hosts reachable over plain SSH/SFTP, and corporate infrastructure locked behind Teleport. This extension replaces external `rsync`/`lftp`/`ssh` tools with Node.js libraries (`ssh2`, `basic-ftp`) and one consistent workflow inside VS Code.

- **One UI, three transports.** Switch between FTP, SFTP, and Teleport from a dropdown. The last selected mode is remembered.
- **Visual config panel.** No need to hand-edit `settings.json`; the `SFTP: Open Configuration` webview writes all fields to your global IDE settings when you click **Save**.
- **Cross-platform.** Works on Windows, macOS, and Linux without installing `rsync`, `lftp`, or `ssh`.
- **Incremental sync.** Compares local and remote file lists and transfers only changed files using parallel `p-queue`.
- **Upload on save.** Optionally upload the current file after every manual `Ctrl+S` or auto-save.
- **File-level commands.** Upload, download, sync, or delete the remote copy of the active file from the Command Palette or editor title.
- **Continuous watching.** Run `SFTP: Start Watching` to sync automatically when files change, with a configurable debounce.
- **Dry run.** Preview what would happen without changing the remote side.
- **Secure credentials.** Passwords are stored in VS Code `SecretStorage`; only configuration values live in `settings.json`.
- **Status bar.** Always see the current state: `logging in`, `syncing`, `watching`, `ready`, or `error`.
- **One active configuration.** The extension keeps a single configuration at a time. To switch to a different server or mode, click **Delete Config** in the webview and save a new one. Your password stays in VS Code `SecretStorage` until you overwrite it.

## What you need

- Visual Studio Code 1.80+ or Devin Desktop
- **No external tools required!** The plugin automatically installs Teleport CLI (`tsh`) on first use for Windows, macOS, and Linux
- Node.js 18.x or higher

The plugin handles everything automatically:
- Detects your operating system and architecture (x64, arm64)
- Downloads the correct Teleport binary from the official CDN
- Installs it in a platform-specific location
- Manages Teleport sessions and re-authentication

## How it works

1. **Activation.** The extension activates on `onStartupFinished` and reads the `sftpPluggin.*` settings.
2. **Mode selection.** `sftpPluggin.mode` is `ftp`, `sftp`, or `teleport`. The webview sets and persists this value.
3. **Teleport CLI auto-installation (Teleport mode only).** Before any Teleport operation, the plugin checks if `tsh` is available. If not, it automatically downloads and installs the correct binary for your platform.
4. **Connection ready-up.**
   - **Teleport:** the extension runs `tsh status`; if the session is missing or expired it runs `tsh login --proxy=<teleportHost> --user=<teleportUser> [--cluster=<teleportCluster>]`, captures the browser link, and opens it with `vscode.env.openExternal`.
   - **SFTP:** `ssh2` connects to `<sftpHost>:<sftpPort>` using password, private key, passphrase, or SSH agent.
   - **FTP:** `basic-ftp` connects to `<ftpHost>:<ftpPort>` with optional explicit TLS.
5. **Transfer.** The sync engine walks `localPath`, lists the remote tree, and uploads missing or changed files using native Node.js streams. Remote files not present locally are deleted. Empty local directories are created remotely.
6. **Upload on save.** `onDidSaveTextDocument` triggers an upload of the saved file when `uploadOnSave` or `uploadOnAutoSave` is enabled.
7. **File watcher.** `SFTP: Start Watching` watches `localPath/**` and runs the sync engine after `debounceMs`.
8. **Status bar.** The status bar shows the current operation and result.

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
| `sftpPluggin.sftpPort` | `number` | `22` | SSH/SFTP port |
| `sftpPluggin.ftpHost` | `string` | `undefined` | FTP server host, e.g. `ftp.example.com` |
| `sftpPluggin.ftpUser` | `string` | `undefined` | FTP username |
| `sftpPluggin.ftpPort` | `number` | `21` | FTP port |
| `sftpPluggin.ftpPassive` | `boolean` | `true` | Use passive mode for FTP |
| `sftpPluggin.ftpSecure` | `boolean` | `false` | Use FTPS (TLS) — encrypted FTP connection; enable if the server requires `AUTH TLS` |
| `sftpPluggin.remotePath` | `string` | `undefined` | Destination directory on the remote host, e.g. `/home/user/project` |
| `sftpPluggin.localPath` | `string` | `undefined` | Local directory to sync from; can be absolute or relative to the first workspace folder |
| `sftpPluggin.identity` | `string` | `undefined` | **Deprecated.** Use `privateKey` instead. |
| `sftpPluggin.privateKey` | `string` | `undefined` | SSH private key path or key content for `sftp`/`teleport` |
| `sftpPluggin.passphrase` | `string` | `undefined` | Passphrase for an encrypted private key |
| `sftpPluggin.agent` | `string` | `undefined` | SSH agent socket or `pageant` on Windows |
| `sftpPluggin.password` | `string` | `undefined` | Stored in VS Code `SecretStorage`; used for FTP and password-based SFTP. Hidden from `settings.json` |
| `sftpPluggin.ignore` | `string[]` | `[]` | Patterns to ignore during sync (e.g. `.git`, `node_modules`) |
| `sftpPluggin.concurrency` | `number` | `4` | Parallel file transfers |
| `sftpPluggin.debounceMs` | `number` | `300` | Milliseconds to wait after a watcher event before syncing |
| `sftpPluggin.uploadOnSave` | `boolean` | `true` | Upload the current file after a manual `Ctrl+S` |
| `sftpPluggin.uploadOnAutoSave` | `boolean` | `false` | Upload the current file after VS Code auto-save |

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
  "sftpPluggin.privateKey": "~/.tsh/keys/...",
  "sftpPluggin.remotePath": "/home/your-sftp-user/project",
  "sftpPluggin.localPath": "${workspaceFolder}/project",
  "sftpPluggin.ignore": [".git", "node_modules"],
  "sftpPluggin.concurrency": 4,
  "sftpPluggin.debounceMs": 300,
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
  "sftpPluggin.privateKey": "~/.ssh/id_rsa",
  "sftpPluggin.remotePath": "/var/www/project",
  "sftpPluggin.localPath": "${workspaceFolder}",
  "sftpPluggin.ignore": [".git", "node_modules"],
  "sftpPluggin.concurrency": 4,
  "sftpPluggin.uploadOnSave": true
}
```

### FTP

```json
{
  "sftpPluggin.mode": "ftp",
  "sftpPluggin.ftpHost": "ftp.example.com",
  "sftpPluggin.ftpUser": "deploy",
  "sftpPluggin.ftpSecure": false,
  "sftpPluggin.remotePath": "/public_html/project",
  "sftpPluggin.localPath": "${workspaceFolder}",
  "sftpPluggin.ignore": [".git"],
  "sftpPluggin.concurrency": 4,
  "sftpPluggin.uploadOnSave": true
}
```

## Step-by-step usage

1. Open `SFTP: Open Configuration` from the Command Palette.
2. Select the transport mode from the **Connection Mode** dropdown and fill the visible fields.
3. Click **Save**. All values are written to your global `settings.json` automatically.
4. Use **Login to Teleport** / **Test Connection** when in `teleport` mode, or jump straight to **Dry Run** / **Sync Now**.
5. Press `Ctrl+S` in any file inside `localPath` to trigger an automatic upload of that file.
6. Use the editor-title buttons or Command Palette to **Upload**, **Download**, **Sync**, or **Delete Remote** for the active file.
7. To auto-upload on every change, run `SFTP: Start Watching`.
8. To switch to a different server or mode, click **Delete Config** in the webview, then save a new configuration. The stored password is preserved unless you overwrite it.

## Commands

- `SFTP: Open Configuration`
- `SFTP: Teleport Login`
- `SFTP: Test Connection`
- `SFTP: Sync Now`
- `SFTP: Dry Run`
- `SFTP: Start Watching`
- `SFTP: Stop Watching`
- `SFTP: Upload Active File`
- `SFTP: Download Active File`
- `SFTP: Sync Active File`
- `SFTP: Delete Remote File`

## Testing

```bash
npm test
```

The test suite covers configuration validation, the webview UI interaction, the progress renderer, and the `saveConfiguration` flow that writes GUI fields to the global settings.

## Notes on the Teleport session

- A Teleport session is valid for about 10 hours. The extension checks the session before every sync, so when it expires the next `Ctrl+S`, `Sync Now`, or watcher-triggered sync automatically starts `tsh login` again and opens the browser.
- **Automatic CLI installation**: If `tsh` is not found, the plugin automatically downloads and installs it for your platform (Windows, macOS, or Linux) from the official Teleport CDN.
- **No manual setup required**: Users don't need to install Teleport CLI manually or add it to their PATH.

## Security

- Configuration is stored in `settings.json` and is safe to share and version-control (no secrets).
- Passwords are stored in VS Code `SecretStorage` and never appear in `settings.json`.
- The `password` field in the webview is a secret input; leaving it empty keeps the existing stored password.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
