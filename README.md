# SFTP Plugin for VS Code (Teleport)

VS Code extension for incremental file sync over `rsync` through a Teleport (`tsh`) tunnel.
Provides a settings UI, browser SSO login, connection test, one-time sync, dry-run preview, and automatic file watcher.

## What you need first

- [Visual Studio Code](https://code.visualstudio.com/) 1.80 or newer (or Devin Desktop)
- [Teleport CLI (`tsh`)](https://goteleport.com/docs/connect-your-client/tsh/) installed and available in `$PATH`
- `rsync` installed (macOS and most Linux distributions include it)
- A Teleport cluster and an SSH/SFTP host reachable through it

## Install the extension

1. Take the built file `sftp-pluggin-0.0.1.vsix`.
2. Open VS Code / Devin Desktop.
3. Open the **Extensions** view (left sidebar, four squares icon).
4. Click the `...` menu (More Actions) and choose **Install from VSIX...**.
5. Select `sftp-pluggin-0.0.1.vsix`.
6. After installation, open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Linux/Windows) and type `SFTP`.

## Configure the plugin

1. Run `SFTP: Open Configuration` in the Command Palette.
2. Fill in the form:

   | Field | Example | What it means |
   |---|---|---|
   | Teleport Host | `example.teleport.com` | Your Teleport proxy host |
   | Teleport User | `oleksii.savchenko` | Your Teleport username |
   | Teleport Cluster | `main` | Teleport cluster name (optional) |
   | SFTP Host | `sftp.example.com` | Target host inside Teleport |
   | SFTP User | `sftp_user` | Username on the target host |
   | Remote Path | `/home/sftp_user/project` | Destination folder on the server |
   | Local Path | `/Users/you/project` | Source folder on your machine |
   | Identity File | `~/.ssh/id_rsa` | SSH key (used only when Teleport is disabled) |
   | Password | — | Stored securely; not used by rsync over Teleport keys |
   | Debounce | `300` | Milliseconds to wait after a change before syncing |

3. Click **Save**.
   Settings are saved in VS Code settings. The password is stored in VS Code Secret Storage.

## Use the plugin

### 1. Log in to Teleport (browser SSO)

If your company uses Microsoft/SSO authentication, you must log in first.

- Run `SFTP: Teleport Login` (or press **Login to Teleport** in the config UI).
- The extension runs `tsh login --proxy=<host> --user=<user> [--cluster=<cluster>]`.
- A browser link appears. The extension opens it in your default browser automatically and also shows the link so you can copy it.
- Enter your login, password, and the Microsoft Authenticator/2FA code in the browser.
- When the browser finishes authentication, `tsh` receives the session and the extension shows **Teleport login successful**.

### 2. Test the connection

Run `SFTP: Test Teleport Connection`. It runs `tsh status` and confirms the session is active.

### 3. Sync files

- `SFTP: Sync Now` — run rsync immediately.
- `SFTP: Dry Run` — preview what rsync would change without applying it.
- `SFTP: Start Watching` — watch your `localPath` and sync automatically after the debounce delay.
- `SFTP: Stop Watching` — stop the file watcher.

## How sync works

With Teleport enabled, the extension sets the environment variable `RSYNC_RSH` to `tsh ssh --cluster=<cluster>` and runs:

```bash
rsync -avz --delete <localPath>/ <sftpUser>@<sftpHost>:<remotePath>/
```

With Teleport disabled, it uses a normal SSH command with the provided identity file.

## Sample configuration file

`sample-config.json` shows the same structure the extension expects:

```json
{
  "teleport": {
    "host": "example.teleport.com",
    "user": "developer",
    "cluster": "main"
  },
  "sftp": {
    "host": "sftp.example.com",
    "user": "sftp_user",
    "remotePath": "/home/sftp_user/project",
    "localPath": "/Users/you/project"
  },
  "sync": {
    "debounceMs": 300
  }
}
```

## Available commands

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

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
