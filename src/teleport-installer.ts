import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as zlib from 'zlib';
import * as cp from 'child_process';
import * as tar from 'tar';

/**
 * Platform-specific configuration for Teleport CLI installation.
 */
interface PlatformConfig {
    os: string;
    arch: string;
    ext: string;
}

/**
 * Detects the current platform and architecture.
 * @returns {PlatformConfig} The platform configuration.
 */
export function getPlatformConfig(): PlatformConfig {
    const platform = os.platform(),
        arch = os.arch();
    
    let osName: string;
    if (platform === 'win32') {
        osName = 'windows';
    } else if (platform === 'darwin') {
        osName = 'darwin';
    } else {
        osName = 'linux';
    }

    let archName: string;
    if (arch === 'x64') {
        archName = 'amd64';
    } else if (arch === 'arm64') {
        archName = 'arm64';
    } else if (arch === 'arm') {
        archName = 'arm';
    } else {
        archName = 'amd64';
    }

    return {
        os: osName,
        arch: archName,
        ext: platform === 'win32' ? '.exe' : '',
    };
}

/**
 * Gets the default installation directory for Teleport CLI.
 * @returns {string} The installation directory path.
 */
export function getTeleportInstallDir(): string {
    const homeDir = os.homedir();
    if (os.platform() === 'win32') {
        return path.join(homeDir, 'AppData', 'Local', 'teleport');
    }
    return path.join(homeDir, '.local', 'share', 'teleport');
}

/**
 * Gets the full path to the tsh executable.
 * @param installDir - Optional custom installation directory.
 * @returns {string} The full path to tsh.
 */
export function getTshPath(installDir?: string): string {
    const dir = installDir || getTeleportInstallDir();
    const config = getPlatformConfig();
    return path.join(dir, `tsh${config.ext}`);
}

/**
 * Checks if tsh is available in PATH or installed locally.
 * @param installDir - Optional custom installation directory.
 * @returns {Promise<boolean>} True if tsh is available.
 */
export async function checkTshAvailable(installDir?: string): Promise<boolean> {
    const localPath = getTshPath(installDir);
    if (fs.existsSync(localPath)) {
        return true;
    }
    
    return new Promise<boolean>((resolve) => {
        cp.exec('tsh --version', (error) => {
            resolve(!error);
        });
    });
}

const DEFAULT_TELEPORT_VERSION = '18.10.0';

/**
 * Finds a system-installed tsh binary in common locations.
 * @returns {string | undefined} The path to tsh, or undefined if not found.
 */
function findSystemTsh(): string | undefined {
    const platform = os.platform();
    const candidates = new Set<string>();
    const envPath = process.env.PATH || '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const binaryName = platform === 'win32' ? 'tsh.exe' : 'tsh';
    for (const dir of envPath.split(delimiter)) {
        if (dir) { candidates.add(path.join(dir, binaryName)); }
    }
    if (platform === 'darwin') {
        candidates.add('/usr/local/bin/tsh');
        candidates.add('/opt/homebrew/bin/tsh');
        candidates.add('/usr/bin/tsh');
    } else if (platform === 'win32') {
        candidates.add(path.join(os.homedir(), 'AppData', 'Local', 'teleport', 'tsh.exe'));
    } else {
        candidates.add('/usr/local/bin/tsh');
        candidates.add('/usr/bin/tsh');
        candidates.add('/opt/teleport/bin/tsh');
    }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Gets the download URL for Teleport CLI.
 * @param version - The Teleport version to download.
 * @returns {string} The download URL.
 */
export function getTeleportDownloadUrl(version = DEFAULT_TELEPORT_VERSION): string {
    const config = getPlatformConfig();
    const baseUrl = 'https://cdn.teleport.dev';
    return `${baseUrl}/teleport-v${version}-${config.os}-${config.arch}-bin.tar.gz`;
}

/**
 * Downloads a file from a URL to a destination path.
 * @param url - The URL to download from.
 * @param dest - The destination file path.
 * @returns {Promise<void>}
 */
function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    fs.unlinkSync(dest);
                    downloadFile(redirectUrl, dest).then(resolve).catch(reject);
                    return;
                }
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlinkSync(dest);
            reject(err);
        });
    });
}

/**
 * Extracts a tar.gz archive to a destination directory.
 * @param archivePath - The path to the archive file.
 * @param destDir - The destination directory.
 * @returns {Promise<void>}
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
    await tar.extract({
        file: archivePath,
        cwd: destDir,
        strip: 1,
    });
}

/**
 * Installs Teleport CLI to the specified directory.
 * @param installDir - Optional custom installation directory.
 * @param version - The Teleport version to install.
 * @returns {Promise<string>} The path to the installed tsh executable.
 */
export async function installTeleport(installDir?: string, version = DEFAULT_TELEPORT_VERSION): Promise<string> {
    const targetDir = installDir || getTeleportInstallDir();
    
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    
    const downloadUrl = getTeleportDownloadUrl(version);
    const tempArchive = path.join(os.tmpdir(), `teleport-${Date.now()}.tar.gz`);
    
    try {
        await downloadFile(downloadUrl, tempArchive);
        await extractTarGz(tempArchive, targetDir);
        
        const config = getPlatformConfig();
        const tshPath = getTshPath(targetDir);
        
        if (os.platform() !== 'win32') {
            fs.chmodSync(tshPath, 0o755);
        }
        
        fs.unlinkSync(tempArchive);
        
        return tshPath;
    } catch (error: any) {
        if (fs.existsSync(tempArchive)) {
            fs.unlinkSync(tempArchive);
        }
        throw new Error(`Failed to install Teleport: ${error.message}`);
    }
}

/**
 * Ensures tsh is available, installing it if necessary.
 * @param installDir - Optional custom installation directory.
 * @returns {Promise<string>} The path to the tsh executable.
 */
export async function ensureTsh(installDir?: string): Promise<string> {
    const systemPath = findSystemTsh();
    if (systemPath) {
        return systemPath;
    }
    const localPath = getTshPath(installDir);
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    const available = await checkTshAvailable(installDir);
    if (available) {
        return 'tsh';
    }

    return installTeleport(installDir);
}

/**
 * Gets the version of the installed tsh.
 * @param installDir - Optional custom installation directory.
 * @returns {Promise<string>} The tsh version string.
 */
export async function getTshVersion(installDir?: string): Promise<string> {
    const tshPath = await ensureTsh(installDir);
    
    return new Promise<string>((resolve, reject) => {
        cp.exec(`${tshPath} --version`, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
}
