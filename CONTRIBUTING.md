**Contributing to SFTP Plugin.**

The source repository is https://github.com/alejoas1981/sftp_pluggin_teleport.

**Development environment.**

1. Clone the repository or your fork and open the repository root in a desktop VS Code environment.
2. Use Node.js and npm compatible with the lockfile. The documentation verification environment used Node.js 22.23.2 and npm 10.9.8.
3. Run npm ci to install the exact dependency versions recorded in package-lock.json.
4. Run npm run compile for TypeScript checking and generation of the out directory.
5. Run npm test for the Mocha suite through ts-node and the VS Code API mock.
6. Run npm run watch when actively developing TypeScript. Run npm run bundle before loading or packaging the bundled extension entry point.
7. There are no dev, build or package npm scripts. The existing packaging script is named build:extension. Run npm run build:extension to create the VSIX in build. Packaging invokes the prepublish hook, which compiles and bundles the runtime.
8. To inspect the UI, launch a VS Code Extension Development Host with this repository as its extension development path. The repository does not provide a committed launch configuration. Use a disposable project and remote test directory.

**Implementation responsibilities.**

1. src/config.ts owns saved workspace configuration and SecretStorage password access.
2. src/extension.ts owns commands, save events, the upload event watcher and UI integration.
3. src/pending-uploads.ts owns persistent versioned upload paths, isolated by connection destination. src/local-change-discovery.ts compares local files with successful history and private inventories on project opening and window focus.
4. src/save-upload-queue.ts owns debounce, serialization and bounded retry scheduling.
5. src/sync-engine.ts owns file analysis, plans, conflict handling and transfer execution.
6. src/sync.ts owns FTP, SFTP and Teleport adapters, operation serialization and Teleport session recovery.
7. src/scan-cache.ts, src/sync-state.ts and src/private-storage.ts own hash reuse, synchronization history and private file staging.
8. src/sync-task.ts owns observable progress independently of the configuration panel.
9. src/webview/config.html, src/webview/config.js and src/webview/config.css are the configuration panel assets loaded by the extension. The older src/webview.html, src/webview.js and src/webview.css files are not the active configuration panel.
10. scripts/bundle.cjs produces the runtime bundle. Native ssh2 accelerators are optional and are excluded from that bundle.

**Coding and verification.**

1. Keep changes within the requested scope and preserve unrelated work.
2. Add JSDoc to new methods and functions. Keep existing JSDoc accurate when behavior changes.
3. Use TypeScript for extension logic. Keep JavaScript consistent with the surrounding webview and build scripts.
4. Group consecutive bindings of the same declaration kind into a comma separated declaration while preserving evaluation order and scope.
5. The repository does not currently configure ESLint, Prettier, coverage thresholds or a lint script. Do not claim those checks ran.
6. Add meaningful regression tests for behavior changes and run the relevant tests followed by the complete suite when integration behavior changes.
7. Update README.md, CHANGELOG.md, sample-config.json and manifest setting descriptions when behavior or configuration changes. Check actual command titles and defaults against package.json.
8. Keep version 3.2.1 unchanged during this development scope. A future version change requires a separate release decision.

**Tests and their limits.**

The test script runs src/test/**/*.test.ts with Mocha and ts-node. It covers configuration and private storage, synchronization planning and conflicts, caches, staged downloads, queue persistence and retries, transfer progress, UI restoration, FTP connection serialization, SFTP adapters, Teleport commands and certificate confirmation. Larger inventory and transfer batches are also exercised.

The tests use temporary local files and model or mocked remote services. They do not establish real server connectivity, actual MFA or TLS trust behavior, native Windows tool compatibility, or the real VS Code webview lifecycle. See RELEASE_CHECKLIST.md for manual verification.

**Packaging and dependency notices.**

The VSIX contains out/extension.js and the active configuration panel assets. The runtime dependencies are bundled, so packaging uses the no dependencies option through the existing npm packaging script. Source tests, node_modules, build scripts, sample-config.json and PLAN.md are excluded by .vscodeignore.

README.md, CHANGELOG.md, LICENSE, THIRD_PARTY_NOTICES.txt and relevant support documents are included. Recheck archive contents after changing .vscodeignore. Regenerate THIRD_PARTY_NOTICES.txt from the actual esbuild input packages when runtime dependencies change. Preserve original dependency license texts and bundled source notices.

**Issues and contributions.**

Use the repository issue tracker for reproducible bugs and feature requests. Include extension and editor versions, connection mode, relevant nonsecret settings, steps and redacted logs. Follow SECURITY.md for sensitive reports. Do not commit server credentials or personal workspace settings.

Describe the problem, resulting behavior and validation in pull requests. Contributions are distributed under the repository MIT license.
