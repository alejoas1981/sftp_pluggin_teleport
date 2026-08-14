# VS Code SFTP Plugin

## Overview

This plugin provides a **graphical interface** for **incremental SFTP synchronization** through **Teleport proxy (`tsh`)**, replacing a legacy shell script with a modern, secure, and reliable solution.

## Features

- **Graphical UI** for configuring Teleport and SFTP parameters (host, user, paths)
- **Connection test** to ensure Teleport access
- **Real-time progress visualization** (progress bar, speed, ETA)
- **Incremental sync** with debouncing and polling to prevent unnecessary transfers
- **Secure credential handling** using VS Code's secure storage API
- **Robust error handling** and retry mechanisms

## Installation

1. Open VS Code
2. Go to Extensions view by clicking on the Extensions icon in the Activity Bar on the left
3. Search for **'SFTP Plugin'**
4. Click **Install**

## Usage

1. Open the Command Palette (`Ctrl+Shift+P`) and type **'SFTP: Configure'** to set up your Teleport and SFTP parameters
2. Use the **Status Panel** to monitor real-time synchronization progress
3. Ensure **Teleport is installed** and configured on your system

## Sample Configuration

A sample configuration file is provided in `sample-config.json`. You can modify this file to suit your environment:

```json
{
  "teleport": {
    "host": "example.teleport.com",
    "user": "developer",
    "proxy": "tsh",
    "cluster": "main"
  },
  "sftp": {
    "host": "sftp.example.com",
    "user": "sftp_user",
    "remotePath": "/home/sftp_user/project",
    "localPath": "./project"
  },
  "sync": {
    "interval": 5000,
    "debounce": 300
  }
}
```

## Testing

Unit tests are in `src/test/`. Run them with `npm test`.

## Contributing

Feel free to contribute by submitting issues or pull requests. For more information, see the [CONTRIBUTING.md](CONTRIBUTING.md) file.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.