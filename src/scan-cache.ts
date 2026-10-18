import * as fs from 'fs';
import * as path from 'path';
import { Fingerprint, fingerprintLocal, metadataSignature } from './sync-state';
import { projectStorage, readPrivateFile, writePrivateFile } from './private-storage';

interface CachedFingerprint extends Fingerprint {
    hash: string;
    signature: string;
    verifiedAt: number;
}

/** Disposable optimization, never the successful-sync baseline. */
export class ScanCache {
    private readonly file: string;
    private readonly entries = new Map<string, CachedFingerprint>();
    hits = 0;
    hashed = 0;

    constructor(private readonly localRoot: string) {
        this.file = path.join(projectStorage(localRoot), 'local-hashes.json');
    }

    async load(): Promise<void> {
        try {
            const content = await readPrivateFile(this.file);
            if (content === undefined) { return; }
            const data = JSON.parse(content);
            if (data.version !== 1 || !Array.isArray(data.entries)) { return; }
            for (const entry of data.entries) {
                const value = entry?.[1];
                if (Array.isArray(entry) && typeof entry[0] === 'string' && value
                    && /^[a-f0-9]{64}$/.test(value.hash) && typeof value.signature === 'string'
                    && Number.isFinite(value.size) && value.size >= 0 && Number.isFinite(value.modifyTime)
                    && Number.isFinite(value.verifiedAt)) { this.entries.set(entry[0], value); }
            }
        } catch { this.entries.clear(); } // Damaged/absent cache never authorizes a transfer.
    }

    async fingerprint(file: string, verifyContents = false): Promise<Fingerprint | undefined> {
        const full = path.join(this.localRoot, file), cached = this.entries.get(file), now = Date.now();
        let stat: fs.BigIntStats;
        try { stat = await fs.promises.lstat(full, { bigint: true }); }
        catch (error: any) {
            if (error.code !== 'ENOENT') { throw error; }
            this.entries.delete(file);
            return undefined;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error(`Not a regular file: ${file}`); }
        if (!verifyContents && cached?.signature === metadataSignature(stat)
            && now >= cached.verifiedAt && now - cached.verifiedAt < 24 * 60 * 60 * 1000) {
            this.hits++;
            return { ...cached };
        }
        const fingerprint = await fingerprintLocal(full);
        if (fingerprint) { this.hashed++; this.remember(file, fingerprint); }
        else { this.entries.delete(file); }
        return fingerprint;
    }

    remember(file: string, fingerprint: Fingerprint): void {
        if (!fingerprint.hash || !fingerprint.signature) { return; }
        this.entries.set(file, { ...fingerprint, hash: fingerprint.hash,
            signature: fingerprint.signature, verifiedAt: Date.now() });
    }

    prune(files: Iterable<string>): void {
        const current = new Set(files);
        for (const file of this.entries.keys()) { if (!current.has(file)) { this.entries.delete(file); } }
    }

    async save(): Promise<void> {
        await writePrivateFile(this.file, JSON.stringify({ version: 1, entries: [...this.entries] }));
    }
}
