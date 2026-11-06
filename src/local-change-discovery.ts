import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { SftpConfig } from './config';
import { normalizeRsyncOptions } from './rsync-options';
import { ScanCache } from './scan-cache';
import { SyncState, SYNC_EXCLUDES, sameMetadata } from './sync-state';
import { readPrivateFile, writePrivateFile } from './private-storage';

/** Finds offline local edits without consulting or recursively listing the server. */
export class LocalChangeDiscovery {
    /** Compares eligible files with successful transfers and the previous local inventory.
     * Pending paths must be persisted by onChange before the new inventory is committed.
     * @param config - Connection identity, local root and exclusions.
     * @param onChange - Persists an eligible changed absolute path.
     * @param signal - Cancels discovery when the extension is deactivated.
     * @returns The number of locally changed paths discovered.
     */
    async scan(config: SftpConfig, onChange: (file: string) => Promise<void>, signal: AbortSignal): Promise<number> {
        config = normalizeRsyncOptions(config);
        const root = config.localPath!, state = new SyncState(config), cache = new ScanCache(root),
            filter = ignore().add(config.ignore ?? []).add(SYNC_EXCLUDES),
            inventoryFile = state.localInventoryFile;
        await state.load();
        await cache.load();
        const previous = await this.loadInventory(inventoryFile), current = new Map<string, string>();
        let changed = 0;
        /** Walks regular local files only, skipping excluded subtrees and symbolic links. */
        const visit = async (directory: string): Promise<void> => {
            this.checkCancellation(signal);
            const entries = await fs.promises.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                this.checkCancellation(signal);
                const full = path.join(directory, entry.name), relative = path.relative(root, full).replace(/\\/g, '/');
                if (entry.isSymbolicLink() || filter.ignores(relative + (entry.isDirectory() ? '/' : ''))) { continue; }
                if (entry.isDirectory()) { await visit(full); continue; }
                if (!entry.isFile()) { continue; }
                let fingerprint;
                try { fingerprint = await cache.fingerprint(relative, config.verifyContents); }
                catch (error: any) {
                    if (error.code === 'ENOENT' || /File changed while scanning/.test(error.message)) { continue; }
                    throw error;
                }
                if (!fingerprint?.hash) { continue; }
                current.set(relative, fingerprint.hash);
                const successful = state.records.get(relative)?.local,
                    baseline = successful?.hash ?? previous?.get(relative),
                    modified = baseline !== undefined ? baseline !== fingerprint.hash
                        : successful ? !sameMetadata(successful, fingerprint) : previous !== undefined;
                if (modified) {
                    this.checkCancellation(signal);
                    await onChange(full);
                    changed++;
                }
            }
        };
        await visit(root);
        this.checkCancellation(signal);
        await cache.save();
        this.checkCancellation(signal);
        await writePrivateFile(inventoryFile, JSON.stringify({ version: 1, entries: [...current] }));
        return changed;
    }

    /** Loads a validated inventory, failing closed if saved state is corrupt.
     * @param file - Private per endpoint inventory path.
     * @returns Previous hashes, or undefined when no inventory has been recorded.
     */
    private async loadInventory(file: string): Promise<Map<string, string> | undefined> {
        const content = await readPrivateFile(file);
        if (content === undefined) { return undefined; }
        const data = JSON.parse(content);
        if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.some((entry: unknown) =>
            !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
            || typeof entry[1] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[1]))) {
            throw new Error('Invalid local change inventory');
        }
        return new Map(data.entries);
    }

    /** Stops discovery before further pending paths or inventories are committed.
     * @param signal - Extension lifecycle cancellation signal.
     * @returns Nothing when the scan may continue.
     */
    private checkCancellation(signal: AbortSignal): void {
        if (signal.aborted) { throw new Error('Local change discovery cancelled'); }
    }
}
