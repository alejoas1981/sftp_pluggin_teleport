**Historical design plan and current implementation.**

This file replaces an obsolete migration proposal. It is a source repository design note, not a list of user instructions or promised future features. It is excluded from the VSIX.

**Implemented in the current 3.2.1 source.**

1. FTP and explicit FTPS use basic-ftp. SFTP uses ssh2. These modes do not require lftp, system ssh or rsync.
2. Teleport uses tsh and rsync through child_process. It does not transfer files through ssh2 or tsh proxy ssh. The external rsync dependency remains intentional in this implementation.
3. SyncEngine plans transfers in both directions with conflict handling and successful transfer history. Automatic deletion is not implemented.
4. A visual configuration panel stores one active configuration privately for the workspace. Legacy VS Code settings remain a fallback until private configuration exists. Passwords use SecretStorage.
5. Manual saves and optional automatic upload events feed a versioned persistent upload queue. External changes do not cancel unrelated active uploads. Temporary errors receive bounded retries.
6. Teleport authentication recovery performs a targeted logout and login and retries a failed operation once. Certificate trust prompts require explicit confirmation.
7. File analysis supports local hash caching, a reusable validated preview plan and remote scan controls. Task state belongs to the extension rather than the webview.
8. The active configuration panel assets are under src/webview. The extension runtime is bundled with esbuild and packaged through vsce.

**Earlier proposals that were not implemented.**

1. Replacing Teleport rsync with an ssh2 connection through tsh proxy ssh was an earlier alternative, not the current transport.
2. Removing child_process completely was not implemented because Teleport still launches external tools.
3. Replacing the full synchronization watcher with a single file upload watcher was not implemented. Start Watching still requests synchronization in both directions. The separate upload queue handles local save and external edit uploads.
4. Legacy useRsync and sshFlags fields remain in the schema for compatibility but do not select or configure a current transport. Extra Rsync Flags has a restricted Teleport parser.

Current user instructions are in README.md. Development instructions are in CONTRIBUTING.md. Manual release checks are in RELEASE_CHECKLIST.md. No additional implementation is authorized by this historical note.
