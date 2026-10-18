import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { projectStorage, readPrivateFile, writePrivateFile, stageDownload } from './private-storage';
import { resolveMode, SftpConfig } from './config';

export const INTERNAL_SYNC_DIRECTORY = '.sftp-sync';
export const SYNC_EXCLUDES = [INTERNAL_SYNC_DIRECTORY, '.git', '.vscode'];

export interface Fingerprint {
    size: number;
    modifyTime: number;
    hash?: string;
    signature?: string;
}

export interface SyncRecord {
    local: Fingerprint;
    remote: Fingerprint;
}

export function sameMetadata(left: Fingerprint | undefined, right: Fingerprint | undefined): boolean {
    return !left || !right ? left === right
        : left.size === right.size && Math.floor(left.modifyTime / 1000) === Math.floor(right.modifyTime / 1000);
}

export function metadataSignature(stat: fs.BigIntStats): string {
    return [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].join(':');
}

export async function fingerprintLocal(file: string): Promise<Fingerprint | undefined> {
    let stat: fs.BigIntStats;
    try { stat = await fs.promises.lstat(file, { bigint: true }); } catch (error: any) {
        if (error.code === 'ENOENT') { return undefined; }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error(`Not a regular file: ${file}`); }
    const hash = createHash('sha256'), signature = metadataSignature(stat);
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    const after = await fs.promises.lstat(file, { bigint: true });
    if (signature !== metadataSignature(after)) { throw new Error(`File changed while scanning: ${file}`); }
    return { size: Number(stat.size), modifyTime: Number(stat.mtimeNs) / 1e6, hash: hash.digest('hex'), signature };
}

function historyEntries(content: string): Array<[string, SyncRecord]> {
    const data = JSON.parse(content),
        valid = (value: any) => value && Number.isFinite(value.size) && value.size >= 0
            && Number.isFinite(value.modifyTime) && (value.hash === undefined || typeof value.hash === 'string');
    if (data.version !== 1 || !Array.isArray(data.entries)) { throw new Error('Unsupported sync history'); }
    for (const entry of data.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
            || !valid(entry[1]?.local) || !valid(entry[1]?.remote)) { throw new Error('Invalid sync history'); }
    }
    return data.entries;
}

/** Stores successful pairs separately for each endpoint, without credentials. */
export class SyncState {
    readonly directory: string;
    private readonly file: string;
    private original = '';
    readonly records = new Map<string, SyncRecord>();

    constructor(private readonly config: SftpConfig) {
        const mode = resolveMode(config),
            identity = [mode, mode === 'ftp' ? config.ftpHost : config.sftpHost,
                mode === 'ftp' ? config.ftpPort ?? 21 : config.sftpPort ?? 22,
                mode === 'ftp' ? config.ftpUser : config.sftpUser,
                config.teleportHost, config.teleportUser, config.teleportCluster,
                path.posix.normalize(config.remotePath!)],
            key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
        this.directory = projectStorage(config.localPath!);
        this.file = path.join(this.directory, `${key}.json`);
    }

    async load(): Promise<void> {
        await this.migrateLegacyHistory();
        const content = await readPrivateFile(this.file);
        if (content !== undefined) {
            for (const [file, record] of historyEntries(content)) { this.records.set(file, record); }
        }
        this.original = this.serialize();
    }

    stageDownload() { return stageDownload(this.directory, this.config.localPath!); }

    async save(): Promise<void> {
        const content = this.serialize();
        if (content === this.original) { return; }
        await writePrivateFile(this.file, content);
        this.original = content;
    }

    /** Copy and verify recognized history before removing it; preserve all unknown files. */
    private async migrateLegacyHistory(): Promise<void> {
        const legacy = path.join(this.config.localPath!, INTERNAL_SYNC_DIRECTORY);
        try {
            const stat = await fs.promises.lstat(legacy);
            if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Unsafe legacy sync history directory'); }
        } catch (error: any) { if (error.code === 'ENOENT') { return; } throw error; }
        for (const name of await fs.promises.readdir(legacy)) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) { continue; }
            const source = path.join(legacy, name), content = await readPrivateFile(source);
            if (content === undefined) { continue; }
            historyEntries(content);
            const target = path.join(this.directory, name), existing = await readPrivateFile(target),
                destination = existing && existing !== content
                    ? path.join(this.directory, 'legacy', `${createHash('sha256').update(content).digest('hex')}.json`) : target;
            await writePrivateFile(destination, content);
            if (await readPrivateFile(destination) !== content || await readPrivateFile(source) !== content) {
                throw new Error('Sync history changed during migration; original was preserved');
            }
            await fs.promises.unlink(source);
        }
        try { await fs.promises.rmdir(legacy); }
        catch (error: any) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) { throw error; } }
    }

    private serialize(): string {
        return JSON.stringify({ version: 1, entries: [...this.records].sort(([a], [b]) => a.localeCompare(b)) });
    }
}
