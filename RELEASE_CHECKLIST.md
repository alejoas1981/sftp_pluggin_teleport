**Release preparation for version 3.2.1.**

This document records release checks to perform. A successful test run or VSIX build does not mean that every manual check below has been completed. No publication is performed by following the local build steps.

**Local checks.**

1. Verify the intended changes in the repository and preserve unrelated edits. Confirm package.json and package-lock.json still declare 3.2.1.
2. Install lockfile dependencies with npm ci when preparing a clean release environment. Run npm run compile and npm test. Record the actual Node.js version and results rather than assuming a fixed test count.
3. Run npm run build:extension. This invokes compilation and bundling before VSIX packaging. The expected artifact is build/sftp-pluggin-3.2.1.vsix.
4. Inspect the VSIX archive. Confirm the bundled entry point, configuration panel assets, manifest, README, changelog, license, notices and support documents are present. Confirm source tests, node_modules, local settings and personal data are absent.
5. Verify every declared setting and command is documented, the optional JSON example parses and uses registered settings, and public metadata points to the real repository and support destination.
6. Check THIRD_PARTY_NOTICES.txt against packages actually included in the runtime bundle. Review dependency changes and maintain their original notices.
7. Install the exact VSIX into a clean desktop VS Code profile. Check the lowest declared supported editor version as well as the editor version used for release testing. Do not treat local build success as proof of minimum editor compatibility.

**Manual server checks.**

1. Configure disposable FTP, explicit FTPS, SFTP and Teleport targets through the panel without editing settings.json. Verify private saved configuration takes precedence over older settings.
2. Check authentication and password persistence. Test SFTP key and agent use where supported. Verify Delete Config does not claim to erase saved credentials or history.
3. Import into an empty directory with nested directories, empty directories, many small files and a large file. Review Dry Run before Sync Now. Check Ignore rules in both directions.
4. Reuse a matching Dry Run plan. Modify a planned local file and then a remote file to confirm stale plans stop execution. Repeat with no prepared plan and after an extension host restart.
5. Change both copies of one file and confirm the conflict is not silently overwritten. Resolve separately through explicit Upload and Download. Verify no automatic deletion occurs.
6. Trigger a burst of external edits, including repeated edits to one file during a transfer. Confirm all latest eligible versions eventually reach the server without unrelated edits cancelling the active upload.
7. Interrupt a transfer. Check bounded retries, preserved pending paths and SFTP Retry Pending Uploads. Restart the extension and verify queue restoration with automatic uploads both enabled and disabled. Establish a local baseline, close the editor, modify an existing file and create a new file, then reopen and verify discovery and upload. Repeat by changing files while another project window has focus. Check that initial baseline creation does not upload every unknown file.
8. Test a genuine Teleport certificate or session failure in a controlled environment. Confirm targeted logout and login, browser authentication when needed, explicit trust confirmation and stopping after repeated failure. Verify unrelated proxy profiles remain usable.
9. Cancel an active upload and download. Confirm real cancellation, no false completion and no partial replacement of an existing local download destination. Remember that interrupted uploads can leave partial remote contents.
10. Compare concurrency settings against server logs. Check FTP connection limits, passive behavior and explicit TLS. Do not describe the FTP Passive setting as active FTP support.
11. Invoke Open Configuration repeatedly and confirm only one tab is created. Close it and verify that the next invocation creates one fresh tab. Close and reopen the configuration panel during a transfer. Check continued work, restored progress, readable logs and warning or error visibility. Check editor button preferences and the active editor behavior of Explorer actions.
12. Validate each platform and external tool combination claimed for the release. Native Windows Teleport tooling and alternate editor distributions require separate verification.

**Publication.**

The publisher identity is alejoas1981. The extension name is sftp-pluggin. Confirm ownership and access to that publisher through Visual Studio Marketplace before any upload. Keep publishing credentials out of the repository and logs.

Keep version 3.2.1 for the current scope. Confirm its publication status in the publisher portal before release. If that version is already published or has been deleted from Marketplace, resolve the version conflict with the owner. Do not silently increment the version or assume the same version can be replaced.

Actual publication is a separate explicit action. Packaging does not prove Marketplace approval or live server compatibility. Record outstanding manual checks before describing a release as verified.

Official publishing reference https://code.visualstudio.com/api/working-with-extensions/publishing-extension.

Official manifest reference https://code.visualstudio.com/api/references/extension-manifest.
