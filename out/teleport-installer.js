"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlatformConfig = getPlatformConfig;
exports.getTeleportInstallDir = getTeleportInstallDir;
exports.getTshPath = getTshPath;
exports.checkTshAvailable = checkTshAvailable;
exports.getTeleportDownloadUrl = getTeleportDownloadUrl;
exports.installTeleport = installTeleport;
exports.ensureTsh = ensureTsh;
exports.getTshVersion = getTshVersion;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const https = __importStar(require("https"));
const cp = __importStar(require("child_process"));
const tar = __importStar(require("tar"));
/**
 * Detects the current platform and architecture.
 * @returns {PlatformConfig} The platform configuration.
 */
function getPlatformConfig() {
    const platform = os.platform(), arch = os.arch();
    let osName;
    if (platform === 'win32') {
        osName = 'windows';
    }
    else if (platform === 'darwin') {
        osName = 'darwin';
    }
    else {
        osName = 'linux';
    }
    let archName;
    if (arch === 'x64') {
        archName = 'amd64';
    }
    else if (arch === 'arm64') {
        archName = 'arm64';
    }
    else if (arch === 'arm') {
        archName = 'arm';
    }
    else {
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
function getTeleportInstallDir() {
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
function getTshPath(installDir) {
    const dir = installDir || getTeleportInstallDir();
    const config = getPlatformConfig();
    return path.join(dir, `tsh${config.ext}`);
}
/**
 * Checks if tsh is available in PATH or installed locally.
 * @param installDir - Optional custom installation directory.
 * @returns {Promise<boolean>} True if tsh is available.
 */
async function checkTshAvailable(installDir) {
    const localPath = getTshPath(installDir);
    if (fs.existsSync(localPath)) {
        return true;
    }
    return new Promise((resolve) => {
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
function findSystemTsh() {
    const platform = os.platform();
    const candidates = new Set();
    const envPath = process.env.PATH || '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const binaryName = platform === 'win32' ? 'tsh.exe' : 'tsh';
    for (const dir of envPath.split(delimiter)) {
        if (dir) {
            candidates.add(path.join(dir, binaryName));
        }
    }
    if (platform === 'darwin') {
        candidates.add('/usr/local/bin/tsh');
        candidates.add('/opt/homebrew/bin/tsh');
        candidates.add('/usr/bin/tsh');
    }
    else if (platform === 'win32') {
        candidates.add(path.join(os.homedir(), 'AppData', 'Local', 'teleport', 'tsh.exe'));
    }
    else {
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
function getTeleportDownloadUrl(version = DEFAULT_TELEPORT_VERSION) {
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
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
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
async function extractTarGz(archivePath, destDir) {
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
async function installTeleport(installDir, version = DEFAULT_TELEPORT_VERSION) {
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
    }
    catch (error) {
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
async function ensureTsh(installDir) {
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
async function getTshVersion(installDir) {
    const tshPath = await ensureTsh(installDir);
    return new Promise((resolve, reject) => {
        cp.exec(`${tshPath} --version`, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
}
