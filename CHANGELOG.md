# Changelog

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
