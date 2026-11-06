**Security and data handling.**

The extension moves local and remote files using configured FTP, FTPS, SFTP or Teleport endpoints. Users choose those endpoints and are responsible for reviewing upload and synchronization plans before using them on important data.

**Configuration and credentials.**

1. Passwords saved through the configuration panel use VS Code SecretStorage. There is no supported password setting in settings.json.
2. Saved form configuration and pending upload paths use VS Code workspace state outside the project. This ordinary configuration storage is not equivalent to SecretStorage. Inline keys, private key paths, key passphrases and connection identities may be present there.
3. Before private form configuration is saved, registered VS Code settings provide the connection configuration. Existing user managed settings are not removed or rewritten by the extension.
4. Delete Config clears connection fields associated with the chosen mode. It does not erase the SecretStorage password, historical settings files, synchronization history or pending upload journals.
5. Private hash caches and per destination transfer history live in global extension storage outside the project. Downloads stage temporary files outside the workspace where the filesystem permits a safe final rename.
6. Removing the extension or changing VS Code profiles can affect storage availability. This documentation makes no promise of secure erasure or transfer of stored state between machines.

**Connection and transfer limits.**

1. Plain FTP transmits credentials and contents without encryption. FTP Secure enables explicit TLS through basic-ftp.
2. SFTP uses ssh2. The adapter currently does not configure known_hosts validation or a pinned server host key. Do not assume that a previously verified host identity is enforced.
3. Teleport uses tsh credentials. The extension does not add an insecure TLS flag. A trust prompt emitted by tsh is forwarded for explicit user confirmation.
4. Downloads replace an existing file only after the transfer and validation succeed. Uploads are not guaranteed to be atomic on the remote server. Interruption can leave a partial server file.
5. Local upload commands intentionally overwrite server versions. Use synchronization with conflict detection when separate remote changes must be considered.
6. Metadata checks do not lock local or remote files. Remote changes retaining both size and modification time can be missed. Symbolic links and path collisions are not automatically resolved.

**Network activity and logs.**

The extension contains no application analytics reporting code. It connects to user configured servers and can download a missing tsh binary from the Teleport CDN. Login can open a browser or copy a login URL to the clipboard. VS Code, the Teleport CLI and connected services have their own network behavior.

Logs and task state can include project paths, remote paths, server names, usernames, command output and authentication links. Remove sensitive values before sharing reports. Do not attach private keys, passwords, MFA codes or full login URLs.

**Reporting a vulnerability.**

For a sensitive report, contact the maintainer at alejoas1981@gmail.com, matching the author contact in package.json. This repository does not advertise a guaranteed response time or a formal supported version policy. Avoid putting exploitable details or credentials in public issues. Nonsecurity defects can be reported through the repository issue tracker.
