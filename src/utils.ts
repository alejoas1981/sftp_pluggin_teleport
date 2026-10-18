import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ignore from 'ignore';

export function normalizeRemotePath(p: string): string {
    const normalized = path.posix.normalize(p || '.');
    if (normalized === '/' || normalized === '.') {
        return normalized;
    }
    return normalized.replace(/\/+$/, '');
}

export function joinRemote(...segments: string[]): string {
    return normalizeRemotePath(path.posix.join(...segments));
}

export function joinLocal(...segments: string[]): string {
    return path.normalize(path.join(...segments));
}

export function isIgnored(rel: string, patterns: string[]): boolean {
    return ignore().add(patterns).ignores(rel);
}

export function ensureLocalDir(localPath: string): void {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
}

export function resolveKeyValue(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }
    if (value.startsWith('~')) {
        return path.join(os.homedir(), value.slice(1).replace(/^\//, ''));
    }
    return value;
}

export function resolvePrivateKey(value?: string): Buffer | string | undefined {
    const resolved = resolveKeyValue(value);
    if (!resolved) {
        return undefined;
    }
    if (resolved.includes('-----BEGIN')) {
        return resolved;
    }
    if (fs.existsSync(resolved)) {
        return fs.readFileSync(resolved);
    }
    return resolved;
}

/** Bounds file workers and FTP connections to the same supported range. */
export function transferConcurrency(value: number | undefined): number {
    return Number.isFinite(value) ? Math.max(1, Math.min(16, Math.floor(value!))) : 4;
}
