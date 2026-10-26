# FTP / SFTP / Teleport Sync for VS Code

A single VS Code extension that keeps your local project folder in sync with a remote host — no matter which transport your team or server uses. Pick **FTP**, **SFTP over SSH**, or **Teleport (`tsh`)**, fill the visual configuration panel, and let the extension handle the rest: secure credential storage, incremental transfers, upload-on-save, continuous watching, dry-run preview, and status-bar feedback.

## Why this plugin

Most teams end up with a mix of remote environments: legacy boxes that only speak FTP, modern cloud hosts reachable over plain SSH/SFTP, and corporate infrastructure locked behind Teleport. FTP and SFTP run through pure Node.js libraries (`ssh2`, `basic-ftp`). Teleport mode wraps `tsh` and `rsync` for incremental transfers.

- **One UI, three transports.** Switch between FTP, SFTP, and Teleport from a dropdown. The last selected mode is remembered.
- **Visual config panel.** No need to hand-edit `settings.json`; the `SFTP: Open Configuration` webview stores configuration privately for this workspace when you click **Save**.
- **Cross-platform.** Works on Windows, macOS, and Linux. FTP and SFTP need no external tools; Teleport mode requires `tsh` and `rsync` (see Windows and Teleport setup).
- **Incremental sync.** Compares local and remote file lists and transfers changed files with bounded parallel workers; FTP/FTPS uses a pool of separate connections.
- **Sync on save.** Upload all locally changed project files after a manual `Ctrl+S` or auto-save.
- **File-level commands.** Upload, download, sync, or delete the remote copy of the active file from the Command Palette or editor title.
- **Continuous watching.** Run `SFTP: Start Watching` to sync automatically when files change, with a configurable debounce.
- **Dry run.** Preview changes without writing project files or sync history, then reuse the validated plan in Sync Now.
- **Secure credentials.** Passwords are stored in VS Code `SecretStorage`; saved form values live in VS Code workspace state outside the project.
- **Status bar.** Always see the current state: `logging in`, `syncing`, `watching`, `ready`, or `error`.
- **One active configuration.** The extension keeps a single configuration at a time. To switch to a different server or mode, click **Delete Config** in the webview and save a new one. Your password stays in VS Code `SecretStorage` until you overwrite it.

## What you need

- Visual Studio Code 1.80+ or Devin Desktop
- **Teleport mode only:** the `tsh` CLI in your `$PATH`
- **Teleport mode on Windows:** `rsync` and `tsh` must be available; see [Windows and Teleport](#windows-and-teleport)

No other external tools are required for FTP and SFTP. FTP and SFTP transfers run through pure Node.js libraries.

## How it works

1. **Activation.** The extension activates on `onStartupFinished` and reads private workspace configuration, falling back to existing `sftpPluggin.*` settings.
2. **Mode selection.** `sftpPluggin.mode` is `ftp`, `sftp`, or `teleport`. The webview sets and persists this value.
3. **Connection ready-up.**
   - **Teleport:** the extension runs `tsh status`; if the session is missing or expired it runs `tsh login --proxy=<teleportHost> --user=<teleportUser> [--cluster=<teleportCluster>]`, captures the browser link, and opens it with `vscode.env.openExternal`.
   - **SFTP:** `ssh2` connects to `<sftpHost>:<sftpPort>` using password, private key, passphrase, or SSH agent.
   - **FTP:** `basic-ftp` connects to `<ftpHost>:<ftpPort>` with optional explicit TLS.
4. **Two-way transfer.** The sync engine lists both trees. Remote-only files and directories are downloaded; local-only files and directories are uploaded. On the first run, modification times select the newer version. Later runs use history to detect changes on both sides and skip conflicts. Files are never deleted automatically.
5. **Sync on save.** Save events queue a batch upload of locally changed files when `uploadOnSave` or `uploadOnAutoSave` is enabled; this does not run two-way synchronization.
6. **File watcher.** `SFTP: Start Watching` watches `localPath/**` and runs the sync engine after `debounceMs`.
7. **Status bar.** The status bar shows the current operation and result.

## Importing a remote project and resolving conflicts

Open an empty local folder, configure the remote project directory, then use **Dry Run** followed by **Sync Now**. The extension downloads the remote files and creates local directories. Git is not required. User Ignore patterns apply in both directions; `.git`, `.vscode`, and `.sftp-sync` are always excluded.

Sync never interprets a missing file as permission to delete its other copy. Removing a file on one side restores it on the next sync. Use the explicit Delete Remote File command only when you intend to delete a server file; also remove its local copy if you do not want it uploaded again.

The first run compares modification times. Different files with equal or unavailable times are reported as conflicts; equal size and time are treated as matching. Keep server and local clocks accurate. After a successful sync, VS Code extension storage holds per-project, per-endpoint history without credentials. Keep this private history to retain conflict detection. Local changes are checked using SHA-256; remote changes use server size and modification time at one-second precision. Remote changes preserving both size and time may not be detected.

When both copies changed, the log lists a conflict and neither copy is overwritten. Open the local file and choose **SFTP: Upload Active File** to keep the local version or **SFTP: Download Active File** to keep the server version. These explicit commands replace the chosen destination and refresh the history. File/directory collisions and symbolic links require manual handling.

Downloads are staged locally so an interrupted transfer does not truncate the current file. Dry Run writes neither project files nor sync history. Watching responds to local filesystem events; use Sync Now to fetch server changes when no local event occurs.

Teleport follows the same planner and uses per-file rsync, without `--delete`. It requires local `tsh` and `rsync`, remote `rsync`, and GNU `find`/`stat`. Extra Rsync Flags accepts `--bwlimit=N`, `--exclude PATTERN`, and `--exclude=PATTERN`, including quoted patterns. Legacy exclusions are merged with Ignore patterns before local scanning and planning; only the bandwidth flag is passed to per-file rsync. Unsupported flags fail before connecting.

## Synchronization progress and parallel transfers (3.2.0)

### Five synchronization fixes

| Reported problem | Implemented behavior |
| --- | --- |
| Dry Run appears frozen during a long remote scan. | Stages, current path, local/remote file counts, directory count, and elapsed time are published every 250 ms. Unknown totals use an indeterminate indicator rather than an invented percentage. |
| Sync repeats the entire Dry Run. | A matching prepared plan is validated and reused for up to 30 minutes without another recursive directory scan. Sync without a plan performs its own analysis. |
| Status bar advances while the Webview loader is frozen. | Both read the same extension-owned task state and percentage. Errors retain the last achieved progress instead of showing a false 100%. |
| Switching tabs loses the progress panel and file log. | The Webview requests the current task when it loads and regains focus. It restores progress, logs, and the result without starting another sync. |
| Closing the Webview interrupts synchronization. | Closing the panel only detaches its observer. It does not cancel the task or close its transport clients. Reopening during execution restores the active task; reopening afterward restores its result. |

**Closing the configuration tab is not cancellation.** No Cancel button was added. Closing VS Code or restarting the extension host is different: in-memory task state and prepared plans do not survive that restart.

### Plan reuse and freshness

Dry Run retains one plan with an ID, creation time, configuration/selection fingerprint, operations, and file metadata. Sync with identical settings validates planned local content hashes and remote size/modification metadata before starting transfers. Changed planned files or directory targets stop execution and require a new analysis. File preconditions are checked again immediately before transfer; downloads are checked again before replacing the local destination.

The plan is consumed once, including a failed attempt. Changing settings, expiration, or an extension-host restart causes a fresh scan. The log explains reuse or expiration/configuration mismatch. Validation still requires metadata requests; unchanged local hashes can be reused. Checks immediately before transfers read local contents again, so validation is not instantaneous. New paths created after the preview require another Dry Run; remote content changes preserving both size and modification time may not be detected.

### Progress and state ownership

The shared state includes task ID, operation type, phase, file counters, completed-file bytes, current path, elapsed time, result, and errors. Scanning reports stages without a percentage. Transfer progress is weighted by bytes of completed files; it does not measure bytes currently streaming within one file. For zero-byte work the engine uses completed operations. Progress stays below 100% until the operation, history persistence, and transport cleanup have succeeded. A completed analysis is not a completed file transfer; conflicts remain visible as a warning.

The panel restores up to 500 recent log entries, each limited to 2000 characters in task state. The Output channel receives the full plain-text log. These limits bound the retained UI log, not the memory required for the file inventory and plan.

`src/sync-task.ts` owns observable state independently of the Webview. `src/sync-engine.ts` owns planning, validation, and execution. `src/sync.ts` owns transport clients and the FTP pool. `src/extension.ts` connects commands, status bar, and panel subscriptions. `src/webview/config.js` renders snapshots and requests fresh state. Disposed-panel exceptions and rejected message promises cannot propagate into the transfer loop. Duplicate full-sync commands are rejected, and configuration/test actions from another panel are blocked while a full sync is active.

### Parallel transfers and log colors

Set **Parallel transfers** (`sftpPluggin.concurrency`) to `1` for one file at a time or `2`-`16` for multiple files; the default is `4`. FTP/FTPS uses separate connections and serializes commands within each connection. Passive/TLS settings apply to each client. Server connection limits may require a lower value. Directory scanning has its own parallelism setting. Prerequisite directory creation remains sequential. SFTP and Teleport also support bounded parallel scanning and transfers.

Transfer workers are bounded instead of creating one queued promise per file. After an error, no further queued files are started; already active workers settle before clients close and the task reports failure. Successful file history is retained for subsequent runs.

In the Webview log, transfer starts are **blue**, completed transfers **green**, and failed transfers **red**, using VS Code theme colors. Text labels remain available independently of color, and file names are inserted as text rather than HTML. The Output channel is not colorized.

### Remaining safety limits

Downloads use a local temporary file so an interrupted download does not truncate an existing destination. Uploads still write directly to the remote destination: an interrupted upload can leave a partial remote copy, although no successful history is recorded for that failed transfer. Atomic remote publication was not added. Metadata checks do not lock files against simultaneous external writers.

### Manual release checks

Use a test copy of a project with nested and empty directories, many small files, and at least one large file. Start with an empty local folder and verify Ignore rules.

1. Run Dry Run and confirm changing counters, paths, and elapsed time throughout the scan.
2. Immediately run Sync and verify `Using Dry Run plan` in the log; metadata validation is expected, another recursive scan is not.
3. Repeat Dry Run, change a planned local file, and confirm Sync refuses the stale plan before transfers. Repeat with a remote size/time change, then analyze again.
4. Restart the extension host and run Sync directly to verify analysis without a prepared plan.
5. Compare status-bar and Webview percentages during transfers. A large in-flight file may hold the percentage steady until completion; elapsed time and the path remain visible.
6. Switch tabs repeatedly and confirm that the active progress and file log return.
7. Close the Webview during a long transfer and verify continued activity through local files or the server log. Reopen before completion, then repeat and reopen after completion. No new task should start automatically.
8. Interrupt the connection during download. Confirm a real error, no false success, and no replacement of an existing local file by a partial download. Restore connectivity and run again.
9. Complete a second synchronization, then repeat the full workflow with a large directory tree.
10. Compare concurrency `1` and `4` using server transfer logs. Repeat with FTP, explicit FTPS/passive settings, and SFTP. Verify the three log colors in the selected VS Code theme.

## Faster scans and private storage (3.2.0)

The first analysis reads local file contents to compute SHA-256 hashes. Subsequent analyses reuse hashes when size, nanosecond modification/change times, inode and device identity match. Cached hashes expire after 24 hours. Enable **Verify all local file contents** for a complete content check. The panel shows reused/read counters; the log records local and remote scan durations. The cache is an optimization, separate from the successful synchronization history used for conflict detection. A corrupt cache is rebuilt.

**Parallel directory scans** defaults to `4` and accepts `1`–`16` for FTP/FTPS, SFTP and Teleport. FTP uses at most the larger of scan concurrency and transfer concurrency in separate connections. Reduce both settings when a server limits connections. Remote directories are freshly listed on every new analysis so additions and deletions can be found. Remote file contents are not downloaded for comparison; size and modification time are used. A remote cache cannot reliably detect arbitrary external changes without fresh server requests. Acceleration depends on tree shape, latency and server limits; a real-server speedup is not guaranteed.

History and local hash caches live beneath VS Code's `ExtensionContext.globalStorageUri`, separated by canonical project path and endpoint. Saved form configuration lives in `workspaceState`; passwords remain in `SecretStorage`. No new `.sftp-sync`, `.vscode/settings.json`, or `.gitignore` is created in the project. Dry Run may update its private hash cache but does not record successful transfers.

Existing recognized `.sftp-sync/<endpoint-hash>.json` history is migrated: copy, verify, then remove the verified old file. Conflicting old history is archived privately; unknown files and unfinished legacy temporary files are preserved. The old directory is removed only when empty. Legacy exclusions remain for compatibility.

Downloads are staged outside the project and workspace, then atomically renamed on the same filesystem. When extension storage is on another volume, staging uses a sibling outside the enclosing workspace/Git repository on the destination volume. If no safe location exists, the download fails instead of truncating the destination or creating internal files inside the project. Temporary staging is cleaned after success or failure. External processes can still change files between checks.

## Windows and Teleport

Teleport mode uses `rsync` over `tsh ssh`. On Windows neither `rsync` nor `tsh` is installed by default. Choose one of the following setups.

### Option 1: WSL (recommended)

1. Install WSL2 and a Linux distribution (for example Ubuntu).
2. Inside WSL install `rsync`:
   ```bash
   sudo apt update && sudo apt install -y rsync
   ```
3. Install the Teleport `tsh` binary for Linux inside WSL, or let the extension download it on first use.
4. Open the project with the **VS Code Remote - WSL** extension so the SFTP plugin runs inside WSL and can call `rsync` and `tsh` directly.

### Option 2: Cygwin or MSYS2

1. Install [Cygwin](https://cygwin.com/) or [MSYS2](https://www.msys2.org/) and include the `rsync` package.
2. Add the `bin` directory (for example `C:\cygwin64\bin` or `C:\msys64\usr\bin`) to your system `PATH`.
3. Install the Teleport `tsh.exe` binary for Windows and add its directory to `PATH`.
4. Restart VS Code.

### Option 3: Native rsync port

1. Install a native Windows `rsync` port such as `cwRsync` and add it to `PATH`.
2. Install `tsh.exe` for Windows and add it to `PATH`.
3. Restart VS Code.

## Install the extension

1. Build or download `sftp-pluggin.vsix`.
2. Open VS Code / Devin Desktop.
3. Go to the **Extensions** view.
4. Click the `...` menu and choose **Install from VSIX...**.
5. Select the `.vsix` file.

## Full configuration reference

The configuration panel saves values in private VS Code workspace state, outside the project. Existing `sftpPluggin.*` settings remain a fallback until a private configuration is saved. After saving, edit connection values in the panel; private values take precedence. Upload-on-save and editor-button preferences still use VS Code Settings. The extension does not create or modify project settings files or `.gitignore`. User-managed existing settings files remain untouched.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sftpPluggin.mode` | `string` | `ftp` | Transport mode: `ftp`, `sftp`, `teleport`. Inferred from `useTeleport` for existing configs. |
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
| `sftpPluggin.concurrency` | `integer` | `4` | Parallel file transfers: `1` for sequential, `2`-`16` for simultaneous transfers; FTP/FTPS uses separate connections |
| `sftpPluggin.scanConcurrency` | `integer` | `4` | Parallel remote directory listings and prepared-plan validation, from `1` to `16`, for all transports |
| `sftpPluggin.verifyContents` | `boolean` | `false` | Bypass the local hash cache and read all local file contents during analysis |
| `sftpPluggin.debounceMs` | `number` | `300` | Milliseconds to wait after a watcher event before syncing |
| `sftpPluggin.uploadOnSave` | `boolean` | `true` | Upload all local changes after manual save; local copies are authoritative |
| `sftpPluggin.uploadOnAutoSave` | `boolean` | `false` | Upload all local changes after auto-save or workspace filesystem edits; local copies are authoritative |
| `sftpPluggin.showUploadButton` | `boolean` | `false` | Show the `SFTP: Upload Active File` button in the editor title |
| `sftpPluggin.showDownloadButton` | `boolean` | `false` | Show the `SFTP: Download Active File` button in the editor title |

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
3. Click **Save**. Configuration values are saved in private VS Code workspace state. Passwords are stored separately in SecretStorage when requested.
4. Use **Login to Teleport** / **Test Connection** when in `teleport` mode, or jump straight to **Dry Run** / **Sync Now**.
5. Press `Ctrl+S` in any file inside `localPath` to synchronize that file with conflict detection.
6. Use the editor-title buttons or Command Palette to **Upload**, **Download**, **Sync**, or **Delete Remote** for the active file.
7. To synchronize on local filesystem changes, run `SFTP: Start Watching`.
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

The `SFTP: Upload Active File` and `SFTP: Download Active File` buttons on the editor title can be shown or hidden with the `sftpPluggin.showUploadButton` and `sftpPluggin.showDownloadButton` settings.

## Testing

```bash
npm test
```

The suite covers configuration, two-way synchronization, conflict detection, Ignore rules, partial downloads, prepared-plan reuse and invalidation, progress, Webview restoration and disposal, bounded logs, FTP/FTPS connection concurrency, SFTP/Teleport adapters, and the watcher. A 1200-file import from a prepared plan and a subsequent sync are exercised with local files and a model remote server.

The 3.2.0 final-fix verification passed **114 tests**. Network and VS Code APIs are mocked in these tests: passing them does not certify a live server, a TLS handshake, or the real VS Code Webview lifecycle. The manual checks below remain necessary before release.

```bash
npm run compile
npm run build:extension
```

The package is generated as `build/sftp-pluggin-3.2.0.vsix`; these fixes do not change the version.

## Notes on the Teleport session

A Teleport session is valid for about 10 hours. The extension checks the session before every sync, so when it expires the next `Ctrl+S`, `Sync Now`, or watcher-triggered sync automatically starts `tsh login` again and opens the browser. You only need to authenticate again in the browser.

## Security

- Configuration is stored in workspace `settings.json`. Review it before sharing: `passphrase` and inline `privateKey` content are configuration fields and may contain secrets. Prefer a key path or SSH agent.
- Passwords are stored in VS Code `SecretStorage` and never appear in `settings.json`.
- The `password` field in the webview is a secret input; leaving it empty keeps the existing stored password.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).

## Upload all local changes on save (3.2.0)

With `sftpPluggin.uploadOnSave: true`, a manual save queues an upload of all locally changed files under the configured local path, including edits made to other files by an IDE or external tool. With `sftpPluggin.uploadOnAutoSave: true`, automatic document saves and file creation/change events inside the open workspace trigger the same queue. Files outside the open workspace are not watched automatically; a document-save event or saving a dirty open document is needed to queue them. Neither option runs a full remote directory scan. The separate Start Watching command retains its two-way synchronization behavior.

Before uploading, the extension saves other dirty, file-backed documents in the configured project. Ignored paths, other projects and untitled documents are excluded. A failed document save stops the batch. VS Code controls its own Auto Save timing; this extension setting controls uploads and does not enable the editor's Auto Save preference.

Each batch scans only paths queued by document saves and filesystem creation/change events, using the private hash cache and successful transfer history for this endpoint. Filesystem changes are queued even with automatic uploading disabled, so the next manual save can send the whole batch. It checks remote metadata only for candidates and their parents, then uploads with the configured transfer concurrency. No downloads or automatic deletions occur. Local versions intentionally replace remote versions, even if the server was edited separately. Use Sync Now instead when you need two-way conflict detection.

Missing history does not mean that every project file changed. Only observed paths enter automatic uploads. An observed file without history is uploaded even when remote size/time match, since matching metadata cannot prove identical contents. Files changed before the extension was active are not automatically discovered by this event queue; use a reviewed Sync Now or an explicit file upload for those changes. A deleted local file does not delete or restore its remote copy in this mode.

Save bursts are debounced using `debounceMs`. A save arriving during a transfer queues another pass; full synchronization and active-file operations defer queued uploads. Successful files retain their history if another file fails. Failures appear in the log and notification; the next save retries outstanding differences without an automatic retry loop. Closing the configuration panel does not stop the queue. Restarting VS Code discards pending events. Re-save the affected files or use a reviewed Sync Now for changes made while the extension was inactive. Successful transfer history persists, so a repeated save does not resend unchanged contents.

After successful completion, both progress indicators show completion for 1.5 seconds, then return to idle: the Webview loader is cleared and hidden, and the status bar shows Ready. Logs and the final result remain in task history. Reopening the panel does not revive a completed loader. Errors and conflict warnings remain visible. A new operation cancels the previous reset timer.
