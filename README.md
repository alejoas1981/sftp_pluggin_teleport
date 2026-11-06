**SFTP Plugin.**

Version 3.2.1 supports FTP, explicit FTPS, SFTP over SSH and Teleport in VS Code desktop. It provides a visual configuration panel, synchronization previews, transfers in both directions and a persistent queue for local uploads.

**Requirements and installation.**

1. Use VS Code 1.80 or later with a desktop extension host. Browser only VS Code is not supported by this Node.js extension.
2. FTP, FTPS and SFTP use bundled JavaScript libraries and require no external transfer commands.
3. Teleport requires local tsh and rsync, plus remote rsync and GNU find and stat. The remote command environment must support the shell commands used by the adapter.
4. Install the VSIX through the Extensions view using Install from VSIX. The package filename for this version is sftp-pluggin-3.2.1.vsix.
5. Teleport on Windows requires a compatible tool environment. Running the extension inside a VS Code WSL extension host with Linux tsh and rsync avoids mixing Windows and Unix paths. Native Windows rsync combinations are not certified by the automated tests.

**Configure without editing JSON.**

1. Open SFTP: Open Configuration from the Command Palette.
2. Select FTP, SFTP or Teleport and enter the connection fields. Set Local path to the absolute project directory and Remote path to the intended server directory. The panel initially fills Local path from the first workspace folder when it is empty.
3. FTP and FTPS need the FTP host and user. Enable FTP Secure for explicit TLS when required. Plain FTP does not encrypt credentials or file contents.
4. SFTP needs the SSH host and remote user. Supply a private key, SSH agent or password as required by the server. Key paths support a leading tilde. Private key, passphrase and agent settings apply to SFTP, not Teleport.
5. Teleport needs the proxy host, Teleport user, target node and remote operating system user. Cluster selection is optional. A proxy can include its port. Teleport authentication uses tsh rather than the SFTP key fields.
6. For password authentication, select Save password before saving. Test Connection can use a password currently entered in the form, but later commands load the saved SecretStorage password. An empty password field does not erase an existing saved password.
7. Click Save before running Dry Run or Sync Now. These actions use saved configuration. Test Connection uses the values currently in the form. In Teleport mode it checks tsh session status rather than proving access to the target node or remote path.
8. Run Dry Run and review the proposed operations before Sync Now. For a first import, use an empty local directory.
9. To change connection values, edit the panel and save again. If the mode selector is disabled, use Delete Config to unlock it in that panel, then choose the mode and save. Delete Config clears fields associated with the selected mode. It does not delete the saved password, old settings files, synchronization history or pending upload journals.

Normal connection setup does not require settings.json. The panel saves one active configuration privately for the workspace. It does not write project settings or gitignore files.

**Settings precedence and optional JSON.**

Before a private configuration has been saved, the extension reads the registered sftpPluggin settings from VS Code. Once private configuration exists, that complete saved configuration takes precedence for connection fields, Ignore rules, concurrency and editor button preferences. Changing those connection values in settings.json will not override the private configuration. Use the panel instead.

The uploadOnSave and uploadOnAutoSave preferences are read directly from VS Code Settings even after private connection configuration is saved. Change them through the Settings editor by searching for their setting names. Manual upload after saving defaults to enabled. Upload after automatic saves or external workspace changes defaults to disabled.

The source file sample-config.json is an optional Teleport settings reference. The extension does not import that file automatically. Copy its entries into VS Code Settings only when deliberately using the settings fallback. Use an absolute localPath. The extension does not expand workspaceFolder or environment variable placeholders in configuration paths. Relative local roots are not resolved consistently across commands and should be avoided.

There is no registered sftpPluggin.password setting. Enter passwords through the panel and store them in SecretStorage. Do not add a password field to settings.json. Private keys and passphrases entered into other configuration fields are ordinary saved values, not SecretStorage secrets.

**Two directions and conflict detection.**

Sync Now scans local and remote trees. Files missing on one side are copied from the other. On the first run the newer modification time wins when comparable. Equal size and time are treated as matching. Different files with equal or unavailable times can be conflicts. Subsequent runs use successful transfer history to detect changes on both sides and skip conflicting files.

Local content comparison uses SHA256. Remote comparison uses size and modification time with one second precision. Remote edits preserving both may be missed. Keep clocks accurate. Sync Active File applies the synchronization policy to the active file. Explicit Upload and Download choose a source and overwrite the destination, updating history after success.

Sync never automatically deletes files. A deletion on one side can be restored by the other side during the next synchronization. Delete Remote File explicitly deletes the server copy of the active file. Remove the local copy too if it must not be uploaded again. Symbolic links and file versus directory collisions require manual handling.

Ignore rules apply in both directions and to queued uploads. The built in exclusions include .git, .vscode and .sftp-sync. The plugin does not automatically exclude node_modules or environment files. Add project specific exclusions before transferring.

Dry Run does not transfer files or record successful transfers. It may update private hash caches and migrate recognized legacy history. A matching prepared plan can be validated and reused once for up to 30 minutes. Changed planned files stop execution. New paths created after a preview require another analysis. Plans and active task state do not survive extension host restarts.

**Local upload queue and AI edits.**

1. Document saves and observed workspace file events record pending paths. Repeated changes to a path update its queued version.
2. With uploadOnSave enabled, a manual save such as Ctrl+S sends the accumulated eligible local changes. This is an upload operation. It intentionally overwrites remote versions and does not perform conflict detection or downloads.
3. With uploadOnAutoSave enabled, editor automatic saves and external workspace edits also start the queue after debounce. This preference does not enable VS Code editor Auto Save.
4. Disk edits do not cancel an active upload. If a file changes while its version is being sent, it remains pending for a subsequent pass. Dirty open project documents are saved before a batch starts.
5. Each batch examines queued paths and relevant server metadata without recursively scanning the remote project. Successful files retain history even if a later transfer fails. Unchanged successful versions are skipped on later attempts.
6. Temporary failures identified by the queue receive up to three retries after delays of 1, 2 and 4 seconds. Permanent errors, exhausted retries and manual cancellation leave paths available for a later request. A new save or explicit retry starts a fresh retry budget.
7. Run SFTP Retry Pending Uploads to request another batch without a full synchronization. The status bar reports pending files or the reason an upload paused.
8. Pending paths are saved in private VS Code workspace state separately for each connection destination. After restart, automatic resumption occurs when uploadOnAutoSave is enabled. Otherwise use a manual save or the retry command. Removed local files do not trigger remote deletion in this mode.
9. Opening a configured project and returning focus to its window scan the local tree for offline changes. Successful transfer history and a private local inventory identify edited and newly created files without scanning the server. The first scan without any inventory establishes a baseline and does not upload unknown existing files. Known successful files can still be checked against their transfer history. Files deleted locally are never sent as remote deletions. With uploadOnAutoSave disabled, discovered paths wait for manual save or retry.
10. The inventory is isolated by destination and kept outside the project. Local hashes can be reused through the existing cache. This feature scans local files and does not promise instantaneous discovery on large projects. Files outside open workspace folders can be found by this scan when they are under the configured absolute local root.

Start Watching is a separate feature. It watches the configured local path and requests complete synchronization in both directions after local file events. It does not poll the server for remote changes and is not equivalent to automatic queued uploading. Use Stop Watching to stop that watcher. Upload preferences continue to govern the separate upload queue.

**Teleport login and recovery.**

The extension searches for an installed tsh in PATH and common locations before using its private installation. If none is found, it attempts to download Teleport 18.10.0 from the Teleport CDN. It does not install rsync. Prefer a tsh version compatible with the server. Automatic installation on native Windows is experimental.

Login uses the configured proxy and user, plus an optional cluster argument. The browser link is opened through VS Code with a clipboard fallback. Session lifetime is controlled by the Teleport server. Successful session checks are cached for up to 60 seconds.

A recognized certificate trust or expired session error during a transfer triggers one targeted logout and login, then one retry of that operation. Browser authentication or MFA can still be required. A repeated authentication failure stops the operation. A certificate trust question emitted by tsh is shown for explicit confirmation. The extension does not silently accept unknown certificates or disable TLS verification. Login has a two minute timeout.

Extra Rsync Flags supports only bandwidth limits and legacy exclusion patterns. Unsupported options are rejected before connecting. Legacy exclusions are merged with Ignore rules. The plugin does not pass deletion or arbitrary shell options to rsync. Teleport batch uploads stream file lists to one rsync session. Full Teleport analysis obtains the remote tree through one recursive command rather than a connection per directory.

**Commands.**

1. SFTP: Open Configuration. Open the connection form and transfer progress panel. Command identifier sftpPluggin.openConfig.
2. SFTP: Sync Now. Synchronize the configured project in both directions. Command identifier sftpPluggin.syncNow.
3. SFTP: Dry Run. Preview synchronization and prepare a reusable plan. Command identifier sftpPluggin.dryRun.
4. SFTP: Start Watching. Start the separate local watcher for complete synchronization. Command identifier sftpPluggin.startWatching.
5. SFTP: Stop Watching. Stop the complete synchronization watcher. Command identifier sftpPluggin.stopWatching.
6. SFTP: Cancel Active Transfer. Cancel the active transport while retaining pending upload paths. Command identifier sftpPluggin.cancelTransfer.
7. SFTP: Teleport Login. Ensure the configured Teleport session is available. Command identifier sftpPluggin.teleportLogin.
8. SFTP: Test Connection. Test the configured connection or Teleport session status. Command identifier sftpPluggin.testTeleport.
9. Upload. Upload the active editor file and overwrite its server copy. Command identifier sftpPluggin.uploadActiveFile.
10. Download. Download the active editor file and overwrite its local copy. Command identifier sftpPluggin.downloadActiveFile.
11. SFTP: Sync Active File. Synchronize the active editor file with conflict detection. Command identifier sftpPluggin.syncFile.
12. SFTP: Delete Remote File. Delete the server copy corresponding to the active editor file. Command identifier sftpPluggin.deleteRemote.
13. SFTP Retry Pending Uploads. Request another batch of pending uploads. Command identifier sftpPluggin.retryUploads.

Upload and Download editor title buttons are hidden by default. Enable them in the configuration panel. Explorer context actions currently operate on the active editor file rather than the file selected only by the context menu. Open the intended file before invoking them.

**Configuration reference.**

These defaults are the values declared to VS Code. Required connection strings default to empty. Saved panel values take precedence as described above. All names below include the sftpPluggin prefix used by VS Code Settings.

1. sftpPluggin.mode. Type string. Default "ftp". Connection mode.
2. sftpPluggin.ftpHost. Type string. Default an empty string. FTP host.
3. sftpPluggin.ftpUser. Type string. Default an empty string. FTP user.
4. sftpPluggin.ftpPort. Type number. Default 21. FTP port (default 21).
5. sftpPluggin.sftpHost. Type string. Default an empty string. SFTP host.
6. sftpPluggin.sftpUser. Type string. Default an empty string. SFTP user.
7. sftpPluggin.sftpPort. Type number. Default 22. SSH port for SFTP mode. Teleport connections use tsh routing instead.
8. sftpPluggin.teleportHost. Type string. Default an empty string. Teleport proxy host.
9. sftpPluggin.teleportUser. Type string. Default an empty string. Teleport user.
10. sftpPluggin.teleportCluster. Type string. Default an empty string. Teleport cluster.
11. sftpPluggin.remotePath. Type string. Default an empty string. Remote path.
12. sftpPluggin.localPath. Type string. Default an empty string. Absolute local project directory. The plugin does not expand workspaceFolder or environment variables.
13. sftpPluggin.privateKey. Type string. Default an empty string. SSH private key path or inline key content for SFTP mode only. Saved form values are ordinary workspace state, not SecretStorage.
14. sftpPluggin.passphrase. Type string. Default an empty string. Private key passphrase for SFTP mode only. Saved form values are ordinary workspace state, not SecretStorage.
15. sftpPluggin.agent. Type string. Default an empty string. SSH agent socket path or pageant for SFTP mode only. Teleport uses tsh credentials.
16. sftpPluggin.ignore. Type array. Default an empty array. Ignore patterns applied to both directions and queued uploads. Built in exclusions always include .git, .vscode and .sftp-sync.
17. sftpPluggin.concurrency. Type integer. Default 4. Parallel file workers from 1 to 16. FTP and FTPS use separate connections. Teleport save batches use one rsync session.
18. sftpPluggin.ftpPassive. Type boolean. Default true. Prefer IPv4 passive FTP when enabled. When disabled, use the library default passive strategy. Active FTP is not implemented.
19. sftpPluggin.ftpSecure. Type boolean. Default false. Use FTPS (TLS) — encrypted FTP connection; enable if the server requires AUTH TLS.
20. sftpPluggin.identity. Type string. Default an empty string. Legacy SFTP key path used only when privateKey is undefined. Prefer privateKey.
21. sftpPluggin.sshFlags. Type string. Default an empty string. Legacy compatibility field. Not used by the current transports.
22. sftpPluggin.rsyncFlags. Type string. Default an empty string. Teleport only. Supports --bwlimit=N, --exclude PATTERN and --exclude=PATTERN. Exclusions join Ignore rules. Other flags are rejected.
23. sftpPluggin.debounceMs. Type number. Default 300. File watcher debounce in milliseconds.
24. sftpPluggin.useRsync. Type boolean. Default false. Legacy compatibility field. Does not select a transport. SFTP uses ssh2 and Teleport always uses tsh with rsync.
25. sftpPluggin.useTeleport. Type boolean. Default false. Legacy mode fallback used only when mode is absent. Select mode explicitly for new configurations.
26. sftpPluggin.uploadOnSave. Type boolean. Default true. Upload queued local project changes after manual save. Local copies overwrite remote copies. Does not run two way conflict detection.
27. sftpPluggin.uploadOnAutoSave. Type boolean. Default false. Upload queued local changes after editor Auto Save or observed workspace file events. Does not enable editor Auto Save. Opening or focusing the project also discovers offline local changes.
28. sftpPluggin.showUploadButton. Type boolean. Default false. Show Upload in the editor title. After saving a private configuration, change this preference in the configuration panel.
29. sftpPluggin.showDownloadButton. Type boolean. Default false. Show Download in the editor title. After saving a private configuration, change this preference in the configuration panel.
30. sftpPluggin.scanConcurrency. Type integer. Default 4. Remote directory scan concurrency from 1 to 16 where individual listings are used. Full Teleport analysis uses one recursive remote command.
31. sftpPluggin.verifyContents. Type boolean. Default false. Read all local file contents during analysis instead of reusing hashes for unchanged metadata.

**Progress, storage and limits.**

The configuration panel is a single tab per extension host. Repeatedly invoking Open Configuration reveals that existing tab. Closing it allows a fresh tab to be created later. The configuration panel and status bar read shared task state. Closing the panel does not cancel a transfer. Reopening restores the current task or recent result. Use Cancel Transfer to interrupt the active transport. Pending uploads are durable, while the active task, recent logs and prepared plan are held in memory.

Scanning shows stages, paths, counters and elapsed time. Transfer percentages advance as files complete, so a large active file can leave the percentage unchanged temporarily. Upload, download and session durations remain visible in results. The panel retains up to 500 recent entries with up to 2000 characters per entry. The Output channel receives the plain transfer log. Successful task progress returns to idle after a short delay.

Transfer concurrency is bounded. FTP and FTPS use separate connections and serialize commands on each connection. Server limits may require lower transfer and scan concurrency. Teleport queued batches use one rsync process despite having multiple files.

Local hash caches and per endpoint synchronization history live in VS Code global extension storage outside the project. Hashes are reused only when cached local metadata matches and expire after 24 hours. Verify contents bypasses cache reuse during analysis. Remote trees are freshly listed for a new analysis. Recognized legacy .sftp-sync history is copied and verified before removal. Unknown legacy files are preserved.

Downloads use temporary staging outside the project and workspace before replacing a validated local destination. If no safe location on the required filesystem is available, the download fails. Uploads are not guaranteed to be atomically published on the server. An interrupted upload can leave a partial remote file, and metadata checks do not lock files against other writers.

**Security and support.**

Passwords use VS Code SecretStorage. Other configuration fields, including inline key content and key passphrases, use ordinary private workspace state after saving the form. Legacy user or workspace settings remain wherever the user originally stored them. Prefer key paths or an agent instead of inline key material. The SFTP adapter currently does not configure known_hosts verification or a pinned server host key. Encryption alone does not establish a previously verified server identity.

The extension has no application analytics reporting code. Network activity includes configured server connections, Teleport CLI downloads when needed and browser authentication. The Teleport CLI and VS Code have their own behavior. Review logs before sharing because paths, server names, usernames and login links can appear.

Report reproducible problems through the repository issue tracker. For details see SECURITY.md, CONTRIBUTING.md and RELEASE_CHECKLIST.md in the source repository. Live server compatibility and Marketplace acceptance are not guaranteed by the mocked tests or by successful packaging.

Repository https://github.com/alejoas1981/sftp_pluggin_teleport.

License terms are in LICENSE. Notices for bundled libraries are in THIRD_PARTY_NOTICES.txt.
