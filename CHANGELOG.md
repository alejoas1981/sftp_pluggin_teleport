# Changelog

## 3.0.0

### Added
- Teleport mode now uses `rsync` over `tsh ssh --cluster=<cluster>` instead of direct SFTP, matching the existing shell workflow.
- `rsyncFlags` are passed through to the `rsync` command in Teleport mode.
- `SyncEngine` progress callback wired to the status bar during sync.
- `syncFile` command now compares size/mtime and uploads or downloads a single file as needed.
- `RemoteClient.stat` for SFTP, FTP, and Teleport.
- Unit tests for `SyncEngine` covering upload, delete, skip, dry-run, and progress.
- `CHANGELOG.md`.

### Fixed
- `deleteConfiguration` now removes `privateKey`, `passphrase`, `agent`, `ignore`, `concurrency`, `ftpPassive`, and `ftpSecure`.
- `ftpPassive` now forces `basic-ftp` into IPv4 passive mode.

### Removed
- Removed unused `useRsync` and `sshFlags` controls from the configuration webview.
