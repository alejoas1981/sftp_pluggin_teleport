import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { SftpConfig } from './config';

const FALLBACK_VERSION = 'v18.10.0',
    SESSION_CACHE_MS = 60000;

let cachedTshPath: string | undefined,
    cachedStorageDir: string | undefined,
    tshInitPromise: Promise<string> | undefined,
    cachedSession:
        | { configKey: string; output: string; validUntil: number }
        | undefined;

/**
 * Options for the Teleport login flow.
 */
export interface LoginOptions {
    onLink?: (url: string) => void;
}

/**
 * Initializes the tsh path cache and returns the resolved binary path.
 * @param storageDir - Directory where downloaded tsh binaries may be cached.
 * @returns {Promise<string>} The absolute path to the tsh executable.
 */
export async function initializeTsh(storageDir: string): Promise<string> {
    cachedStorageDir = storageDir;
    tshInitPromise = resolveTshPath({
        platform: process.platform,
        env: process.env,
        storageDir,
    });
    cachedTshPath = await tshInitPromise;
    return cachedTshPath;
}

/**
 * Returns the cached tsh path, resolving it if necessary.
 * @returns {Promise<string>} The absolute path to the tsh executable.
 */
export async function getTshPath(): Promise<string> {
    if (cachedTshPath) { return cachedTshPath; }
    if (tshInitPromise) { return tshInitPromise; }
    if (!cachedStorageDir) {
        throw new Error('tsh has not been initialized. Call initializeTsh first.');
    }
    cachedTshPath = await resolveTshPath({
        platform: process.platform,
        env: process.env,
        storageDir: cachedStorageDir,
    });
    return cachedTshPath;
}

/**
 * Clears the cached tsh path and session. Useful for tests.
 * @returns {void}
 */
export function resetTshCache(): void {
    cachedTshPath = cachedStorageDir = cachedSession = tshInitPromise = undefined;
}

interface ResolveTshOptions {
    platform: string;
    env: NodeJS.ProcessEnv;
    storageDir: string;
}

/**
 * Resolves the tsh executable path, downloading it on Windows when missing.
 * @param options - Platform, environment and storage details.
 * @returns {Promise<string>} The absolute path to the tsh executable.
 */
async function resolveTshPath(options: ResolveTshOptions): Promise<string> {
    const existing = findInPath('tsh', options.platform, options.env);
    if (existing) { return existing; }
    if (options.platform === 'win32') {
        return installTshWindows(options.storageDir);
    }
    throw new Error(
        'tsh is not installed. Install the Teleport CLI from https://goteleport.com/download and add it to PATH.'
    );
}

/**
 * Looks for a named executable on the system PATH.
 * @param name - The executable name without extension.
 * @param platform - The current platform, e.g. 'win32' or 'darwin'.
 * @param env - The process environment.
 * @returns {string | undefined} The full path, or undefined if not found.
 */
export function findInPath(
    name: string,
    platform: string,
    env: NodeJS.ProcessEnv
): string | undefined {
    const pathKey = platform === 'win32' ? (env.Path || env.PATH || '') : (env.PATH || ''),
        separator = platform === 'win32' ? ';' : ':',
        dirs = pathKey.split(separator).filter((d) => d.length > 0);

    if (platform === 'win32') {
        const exts = (env.PATHEXT || '.EXE;.CMD;.BAT')
            .split(';')
            .map((ext) => ext.toLowerCase());
        for (const dir of dirs) {
            const base = path.join(dir, name);
            for (const ext of exts) {
                const full = ext ? `${base}${ext}` : base;
                if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                    return full;
                }
            }
        }
        return undefined;
    }

    for (const dir of dirs) {
        const full = path.join(dir, name);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            return full;
        }
    }
    return undefined;
}

/**
 * Downloads and extracts the Windows tsh binary into the extension cache.
 * @param storageDir - Directory where the binary will be cached.
 * @returns {Promise<string>} The absolute path to tsh.exe.
 */
async function installTshWindows(storageDir: string): Promise<string> {
    const version = await resolveLatestVersion(),
        base = `teleport-${version}-windows-amd64-bin`,
        cacheDir = path.join(storageDir, 'tsh-cache'),
        zipPath = path.join(cacheDir, `${base}.zip`),
        extractDir = path.join(cacheDir, base);

    fs.mkdirSync(cacheDir, { recursive: true });

    const existing = findTshExe(extractDir);
    if (existing) { return existing; }

    const url = `https://cdn.teleport.dev/${base}.zip`;
    await downloadFile(url, zipPath);

    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    const tshExe = findTshExe(extractDir);
    if (!tshExe) {
        throw new Error('tsh.exe was not found in the downloaded Teleport archive.');
    }
    return tshExe;
}

/**
 * Fetches the latest Teleport release tag from GitHub, falling back to a hard-coded version.
 * @returns {Promise<string>} The release tag such as 'v18.10.0'.
 */
async function resolveLatestVersion(): Promise<string> {
    try {
        const data = await httpsGetJson<{ tag_name?: string }>(
            'https://api.github.com/repos/gravitational/teleport/releases/latest'
        );
        if (data?.tag_name) { return data.tag_name; }
    } catch {
        // fall through to hard-coded version
    }
    return FALLBACK_VERSION;
}

/**
 * Performs an HTTPS GET and parses the response as JSON.
 * @param url - The URL to fetch.
 * @returns {Promise<T>} The parsed JSON body.
 */
function httpsGetJson<T>(url: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        https
            .get(
                url,
                { headers: { 'User-Agent': 'sftp-pluggin' } },
                (res) => {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const location = res.headers.location;
                        if (location) {
                            httpsGetJson<T>(location).then(resolve, reject);
                            return;
                        }
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => {
                        try {
                            const text = Buffer.concat(chunks).toString('utf8');
                            resolve(JSON.parse(text) as T);
                        } catch (error) {
                            reject(error);
                        }
                    });
                }
            )
            .on('error', reject);
    });
}

/**
 * Downloads a remote file to a local path, following redirects.
 * @param url - The source URL.
 * @param dest - The destination file path.
 * @returns {Promise<void>}
 */
function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        https
            .get(url, { headers: { 'User-Agent': 'sftp-pluggin' } }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    const location = res.headers.location;
                    if (location) {
                        downloadFile(location, dest).then(resolve, reject);
                        return;
                    }
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    return;
                }
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => {
                    file.close((err) => (err ? reject(err) : resolve()));
                });
                file.on('error', (err) => {
                    fs.unlink(dest, () => reject(err));
                });
            })
            .on('error', reject);
    });
}

/**
 * Extracts a zip archive using the system's tar command.
 * @param zipPath - The archive to extract.
 * @param destDir - The destination directory.
 * @returns {Promise<void>}
 */
function extractZip(zipPath: string, destDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = cp.spawn('tar', ['-xf', zipPath, '-C', destDir], { env: process.env });
        let stderr = '';
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`tar extraction failed: ${stderr || code}`));
                return;
            }
            resolve();
        });
    });
}

/**
 * Recursively searches a directory for the tsh.exe binary.
 * @param dir - The root directory to search.
 * @returns {string | undefined} The path to tsh.exe, if found.
 */
function findTshExe(dir: string): string | undefined {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            const found = findTshExe(full);
            if (found) { return found; }
        } else if (e.isFile() && e.name.toLowerCase() === 'tsh.exe') {
            return full;
        }
    }
    return undefined;
}

/**
 * Runs a one-shot tsh command and returns its stdout.
 * @param args - The tsh arguments.
 * @param options - Optional tsh path override.
 * @returns {Promise<string>} The command output.
 */
export async function runTshCommand(
    args: string[],
    options: { tshPath?: string } = {}
): Promise<string> {
    const tshPath = options.tshPath ?? await getTshPath();
    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn(tshPath, args, { env: process.env });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('error', (error: any) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error('tsh is not installed or not in PATH.'));
                return;
            }
            reject(error);
        });
        child.on('close', (code) => {
            if (code !== 0) {
                const message = stderr.trim() || stdout.trim() || `tsh exited with code ${code}`;
                reject(new Error(message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Logs in to Teleport and returns the command output.
 * @param config - The SFTP configuration.
 * @param options - Optional login options, including a link callback.
 * @returns {Promise<string>} The login output.
 */
export async function loginToTeleport(
    config: SftpConfig,
    options: LoginOptions = {}
): Promise<string> {
    const tshPath = await getTshPath();
    const args: string[] = ['login'];
    if (config.teleportHost) {
        args.push(`--proxy=${config.teleportHost}`);
    }
    if (config.teleportUser) {
        args.push(`--user=${config.teleportUser}`);
    }
    if (config.teleportCluster) {
        args.push(config.teleportCluster);
    }

    return new Promise<string>((resolve, reject) => {
        const child = cp.spawn(tshPath, args, { env: process.env });
        let stdout = '', stderr = '', linkSent = false;

        const handleData = (data: Buffer): void => {
            const text = data.toString();
            if (options.onLink) {
                const proxyHost = config.teleportHost
                    ? config.teleportHost.replace(/^https?:\/\//, '').split('/')[0]
                    : undefined;
                const matches = text.match(/https?:\/\/[^\s]+/g);
                const url = matches?.find((u) => !proxyHost || u.includes(proxyHost.split(':')[0]))
                    || matches?.[0];
                if (url && !linkSent) {
                    linkSent = true;
                    options.onLink(url);
                }
            }
        };

        child.stdout.on('data', (data) => { stdout += data.toString(); handleData(data); });
        child.stderr.on('data', (data) => { stderr += data.toString(); handleData(data); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const message = stderr.trim() || stdout.trim() || `tsh login exited with code ${code}`;
                reject(new Error(message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Verifies that the cached tsh session is still active, logging in if necessary.
 * @param config - The SFTP configuration.
 * @param options - Optional login options.
 * @returns {Promise<string>} The session status output.
 */
export async function ensureTeleportSession(
    config: SftpConfig,
    options: LoginOptions = {}
): Promise<string> {
    if (!config.teleportHost || !config.teleportUser) {
        throw new Error('Teleport host and user are required');
    }
    const key = `${config.teleportHost}:${config.teleportUser}:${config.teleportCluster}`;
    if (cachedSession && cachedSession.configKey === key && Date.now() < cachedSession.validUntil) {
        return cachedSession.output;
    }
    try {
        const out = await runTshCommand(['status']);
        const lowerOut = out.toLowerCase();
        if (['not logged in', 'expired', 'relogin', 'session expired'].some((msg) => lowerOut.includes(msg))) {
            throw new Error('Teleport session not active');
        }
        cachedSession = { configKey: key, output: out, validUntil: Date.now() + SESSION_CACHE_MS };
        return out;
    } catch {
        const out = await loginToTeleport(config, options);
        cachedSession = { configKey: key, output: out, validUntil: Date.now() + SESSION_CACHE_MS };
        return out;
    }
}
