# Changelog

## 3.2.1

### Changed

- Save-triggered Teleport uploads batch multiple changed files into one rsync session instead of opening one session per file.
- Teleport rsync uses `--ignore-times` after the plugin identifies changed files. This preserves rsync's delta-transfer algorithm without the extra full-file reads caused by `--checksum`.

### Added

- The configuration panel shows **Cancel Transfer** while synchronization is active. Cancelling aborts the active Teleport, SFTP, or FTP transport.

## 3.2.0

### Changed
- Sync Now, Sync Active File, save-triggered sync and watching use the same two-way policy for FTP, SFTP and Teleport. An empty local folder imports the remote project.
- Missing files are copied to the other side; automatic deletion and Teleport directory mirroring with `--delete` have been removed.
- On first sync, different modification times choose the newer copy. A per-endpoint history tracks later changes and skips files changed on both sides. Explicit Upload/Download Active File resolves a file conflict and refreshes its history.
- Transfer logs and dry runs include uploads, downloads, directory creation and conflicts.
- Downloads use temporary files and only replace the destination after validation. Symbolic links and file/directory collisions are skipped as conflicts.
- `.sftp-sync`, `.git` and `.vscode` are excluded from sync. History and temporary files do not trigger the watcher.
- Teleport uses per-file rsync with fixed safe arguments; Extra Rsync Flags only accepts `--bwlimit=N`. Use Ignore patterns for exclusions.

### Limitations
- Remote change detection uses server-reported size and modification time, at one-second precision. Remote edits preserving both may not be detected. First-run files with equal size and time are treated as matching.
- Teleport requires local `tsh`/`rsync`, remote `rsync`, and GNU `find`/`stat`. No Git installation is needed.

## 3.1.2

### Added
- Scrollable live transfer log in the configuration panel for FTP, SFTP, and Teleport sync and dry runs.
- Automatic scrolling to the log on launch, with output following that pauses when reading earlier entries.
- Per-file start, completion, failure, and preview entries; streamed rsync output for Teleport.

### Fixed
- Replace clipped button icons with consistent SVG outlines.
- Prevent duplicate panel operations during synchronization.
- Dry runs no longer create the remote root directory.

## 3.1.1

### Fixed
- Serialize complete FTP/FTPS operations on each connection, including directory changes and transfers, to prevent overlapping-task errors during synchronization.
- Request FTP file size and modification time sequentially so existing files are not mistaken for missing files after a command collision.
- Wait for pending FTP operations before closing the connection.

## 3.1.0

### Added
- Teleport `tsh` auto-discovery and optional auto-install for macOS and Linux.
- `tsh login` uses `--browser=none`; the SSO link is captured and opened via VS Code with a clipboard fallback.
- `tsh` binary is searched in `PATH` and common install directories before downloading.
- Correct CDN URL for the Teleport tarball: `teleport-v${version}-${os}-${arch}-bin.tar.gz`.

### Fixed
- `ensureTsh` no longer tries to download when a system `tsh` is available.
- `openTeleportLink` now falls back to clipboard if the browser cannot be opened.

### Known limitations
- Teleport file sync still depends on `rsync` over `tsh ssh`; `rsync` must be available locally.
- Windows `tsh` auto-install uses a tarball and is experimental; use WSL or a manual install for best results.
