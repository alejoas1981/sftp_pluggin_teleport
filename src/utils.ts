import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ignore from 'ignore';

/**
 * Normalizes a remote path to POSIX format and trims trailing slashes.
 * @param p - The raw remote path.
 * @returns {string} The normalized remote path.
 */
export function normalizeRemotePath(p: string): string {
    const normalized = path.posix.normalize(p || '.');
    if (normalized === '/' || normalized === '.') {
        return normalized;
    }
    return normalized.replace(/\/+$/, '');
}

/**
 * Joins remote path segments and normalizes the result.
 * @param segments - The path segments to join.
 * @returns {string} The joined remote path.
 */
export function joinRemote(...segments: string[]): string {
    return normalizeRemotePath(path.posix.join(...segments));
}

/**
 * Joins local path segments and normalizes the result.
 * @param segments - The path segments to join.
 * @returns {string} The joined local path.
 */
export function joinLocal(...segments: string[]): string {
    return path.normalize(path.join(...segments));
}

/**
 * Determines whether a relative path matches any ignore pattern.
 * @param rel - The relative path to check.
 * @param patterns - The ignore patterns.
 * @returns {boolean} True when the path should be ignored.
 */
export function isIgnored(rel: string, patterns: string[]): boolean {
    return ignore().add(patterns).ignores(rel);
}

/**
 * Ensures the parent directory for a local file path exists.
 * @param localPath - The local file path.
 * @returns {void}
 */
export function ensureLocalDir(localPath: string): void {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
}

/**
 * Resolves a value that may start with a tilde to an absolute path.
 * @param value - The raw value, optionally starting with ~.
 * @returns {string | undefined} The resolved value, or undefined when empty.
 */
export function resolveKeyValue(value?: string): string | undefined {
    if (!value) { return undefined; }
    if (value.startsWith('~')) {
        return path.join(os.homedir(), value.slice(1).replace(/^\//, ''));
    }
    return value;
}

/**
 * Resolves a private key value or file path to a key buffer or string.
 * @param value - The key path or key content.
 * @returns {Buffer | string | undefined} The resolved private key, or undefined.
 */
export function resolvePrivateKey(value?: string): Buffer | string | undefined {
    const resolved = resolveKeyValue(value);
    if (!resolved) { return undefined; }
    if (resolved.includes('-----BEGIN')) { return resolved; }
    if (fs.existsSync(resolved)) { return fs.readFileSync(resolved); }
    return resolved;
}

/** Default patterns to skip during sync. */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
    '.git',
    '.vscode',
    '.windsurfrules',
    'node_modules',
    '.DS_Store',
    '*.log',
    '.env',
    'vendor',
    'debugbar',
    'cache',
];

/**
 * Merges default and user ignore patterns.
 * @param userPatterns - Patterns from the user configuration.
 * @returns {string[]} The combined pattern list.
 */
export function getIgnorePatterns(userPatterns?: string[]): string[] {
    return [...DEFAULT_IGNORE_PATTERNS, ...(userPatterns ?? [])];
}

/**
 * Escapes a shell argument by wrapping it in single quotes.
 * @param arg - The argument to escape.
 * @returns {string} The escaped argument.
 */
export function escapeShell(arg: string): string {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
