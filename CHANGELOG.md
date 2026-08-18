# Changelog

## [2.0.0] - Cross-Platform Release with Auto-Installer

### Added
- **Full cross-platform support**: Windows, macOS, and Linux without external dependencies
- **Automatic Teleport CLI installation**: Downloads and installs `tsh` binary automatically on first use
- **Native Node.js file synchronization**: Replaced `rsync` with custom implementation using `ssh2` library
- **Platform detection**: Automatic OS and architecture detection (x64, arm64) for correct binary download
- **Binary integrity verification**: SHA256 checksum validation for downloaded Teleport binaries
- **Unit tests**: Comprehensive test coverage for teleport installer module (22 tests)
- **JSDoc documentation**: Full documentation for all functions and classes following Clean Code principles

### Changed
- **Removed rsync dependency**: File synchronization now uses native Node.js streams via `ssh2`
- **Removed external tsh requirement**: Plugin automatically downloads and installs Teleport CLI if missing
- **Improved file transfer logic**: Streaming-based file transfers with progress tracking
- **Enhanced error handling**: Better error messages and recovery for network interruptions
- **Updated dependencies**: Added `tar` package for archive extraction across platforms

### Fixed
- **Windows path handling**: Proper path resolution for Windows environments
- **Architecture detection**: Correct ARM64 support for Apple Silicon and Windows ARM
- **Large directory sync**: Fixed issues with synchronizing directories with many files
- **Session management**: Improved Teleport session validation and re-authentication

### Removed
- **rsync external dependency**: No longer requires rsync to be installed
- **Manual tsh installation**: Users no longer need to manually install Teleport CLI

### Technical Notes
- Minimum Node.js version: 18.x
- Uses `ssh2` library for SSH/SFTP connections after `tsh login` authentication
- Teleport binaries downloaded from official CDN (https://cdn.teleport.dev)
- All file operations use Node.js native `fs` and `stream` modules
