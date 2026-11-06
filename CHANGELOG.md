**Changelog.**

**3.2.1.**

The configuration panel now reuses a single tab. Local changes made while the editor was closed are discovered on project opening and window focus using successful history and a private baseline inventory. Automatic upload follows uploadOnAutoSave. An initial inventory without history does not upload the entire project.

1. Local save and external edit uploads use a persistent versioned path queue. New disk changes retain newer versions without cancelling an unrelated active upload.
2. Pending paths survive extension restarts and are isolated by connection destination. Added SFTP Retry Pending Uploads and status feedback for pending or paused uploads.
3. Temporary upload failures receive bounded retries with increasing delays. Cancellation and persistent errors preserve pending work for a later request.
4. Recognized Teleport certificate and session failures trigger targeted logout and login followed by one operation retry. Certificate trust prompts require explicit confirmation. Browser login links remain available and login has a timeout.
5. Teleport uploads batch selected files into one rsync session with a file list streamed through stdin. Metadata path lists are streamed too. Full Teleport analysis uses one recursive remote listing command.
6. Teleport forces transfer of locally identified changed files while preserving the rsync delta algorithm. Legacy rsync exclusions join the common Ignore rules and bandwidth limits remain supported.
7. Local hash caches and synchronization history use private extension storage. Cached local hashes are persisted before remote analysis and can be reused when metadata matches. Directory scan concurrency and complete local content verification are configurable.
8. The progress panel supports cancellation, shared restored task state, bounded recent logs and live upload, download and complete session durations. Closing the panel does not cancel a task.
9. The runtime and dependencies are bundled into one JavaScript entry point for packaging.
10. Documentation now describes actual settings precedence, optional JSON configuration, current commands and scripts, transport limits and release verification. Corrected the optional settings example and license attribution. Added security information and bundled dependency notices. Version remains 3.2.1.

**3.2.0.**

1. Introduced shared synchronization in both directions for FTP, SFTP and Teleport, including remote project import into an empty local directory.
2. Replaced automatic deletion and directory mirroring with copying missing files. Added history based conflict detection and explicit file commands to select an authoritative copy.
3. Added transfer and conflict plans, temporary download staging, symbolic link and path collision handling, and exclusions for internal state, Git and VS Code settings.
4. Teleport used per file rsync with restricted arguments. Later 3.2.1 changes introduced batching and legacy exclusion parsing. Save behavior described for this historical version was superseded by the local upload queue.
5. Remote comparison used server size and modification time. Changes preserving both could be missed. Teleport required local tsh and rsync, remote rsync and GNU find and stat.

**3.1.2.**

1. Added a scrollable live transfer log in the configuration panel, automatic following and per file activity entries.
2. Updated transfer button icons, prevented duplicate panel operations and stopped Dry Run from creating the remote root directory.

**3.1.1.**

1. Serialized FTP operations per connection, including directory changes, metadata requests and transfers.
2. Waited for pending FTP work before closing the connection.

**3.1.0.**

1. Added tsh discovery and an automatic installation path for macOS and Linux, with experimental Windows support.
2. Added browser login link capture and clipboard fallback, common binary search locations and the corrected Teleport archive URL format.
3. Teleport remained dependent on external rsync. Automatic native Windows tooling was not certified.
