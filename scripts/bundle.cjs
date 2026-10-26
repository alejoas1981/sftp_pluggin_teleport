const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

/**
 * Bundles the extension runtime and normalizes generated whitespace for clean diffs.
 * Native ssh2 accelerators remain optional so one VSIX works across supported platforms.
 * @returns {Promise<void>} Resolves after the bundle is written and normalized.
 */
async function bundleExtension() {
    const output = path.resolve(__dirname, '..', 'out', 'extension.js');
    await esbuild.build({
        entryPoints: [path.resolve(__dirname, '..', 'src', 'extension.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node16',
        external: ['vscode', 'cpu-features', '*.node'],
        outfile: output
    });
    const normalized = fs.readFileSync(output, 'utf8').replace(/[ \t]+$/gm, '');
    fs.writeFileSync(output, normalized);
}

bundleExtension().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
