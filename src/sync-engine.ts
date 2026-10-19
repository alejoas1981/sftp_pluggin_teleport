import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { createHash, randomUUID } from 'crypto';
import { transferConcurrency } from './utils';
import { ScanCache } from './scan-cache';
import type { SftpConfig } from './config';
import type { RemoteClient, RemoteItem, SyncOptions } from './sync';
import { Fingerprint, fingerprintLocal, sameMetadata, SyncState, SYNC_EXCLUDES } from './sync-state';

interface Entry extends Fingerprint {
    isDirectory: boolean;
    isSymbolicLink?: boolean;
}

type Action = 'upload' | 'download' | 'mkdirLocal' | 'mkdirRemote' | 'conflict' | 'unchanged';
interface PreparedPlan {
    key: string;
    id: string;
    createdAt: number;
    items: PlannedFile[];
}
let preparedPlan: PreparedPlan | undefined;

interface PlannedFile {
    file: string;
    action: Action;
    local?: Entry;
    remote?: Entry;
    reason?: string;
}

function sameLocal(left: Fingerprint | undefined, right: Fingerprint | undefined): boolean {
    return !left || !right ? left === right : left.hash === right.hash && left.size === right.size;
}

function describe(item: PlannedFile): string {
    const labels: Record<Action, string> = {
        upload: 'UPLOAD local to server', download: 'DOWNLOAD server to local',
        mkdirLocal: 'CREATE DIRECTORY locally', mkdirRemote: 'CREATE DIRECTORY on server',
        conflict: 'CONFLICT — skipped', unchanged: 'UNCHANGED',
    };
    return `${labels[item.action]}: ${item.file}${item.reason ? ` (${item.reason})` : ''}`;
}

/** One non-destructive synchronization policy shared by all transports. */
export class SyncEngine {
    private cache?: ScanCache;
    constructor(private readonly config: SftpConfig) {}

    async sync(client: RemoteClient, options: SyncOptions = {}): Promise<string> {
        const state = new SyncState(this.config),
            filter = ignore().add(this.config.ignore ?? []).add(SYNC_EXCLUDES),
            key = createHash('sha256').update(JSON.stringify([this.config, options.files])).digest('hex');
        await state.load();
        this.cache = new ScanCache(this.config.localPath!);
        await this.cache.load();
        let plan: PlannedFile[];
        const cached = preparedPlan;
        preparedPlan = undefined;
        if (!options.dryRun && cached?.key === key && Date.now() - cached.createdAt < 30 * 60 * 1000) {
            plan = cached.items;
            options.onState?.({ phase: 'Validating prepared plan', planId: cached.id });
            options.onLog?.(`Using Dry Run plan ${cached.id}; validating planned files…\n`);
            await this.validatePreparedPlan(client, plan, options);
        } else {
            if (cached && !options.dryRun) { options.onLog?.('Plan expired or configuration changed; scanning again.\n'); }
            options.onLog?.('Scanning local and remote files…\n');
            const started = Date.now(), local = await this.collectLocal(filter, options.files, options),
                localFinished = Date.now();
            options.onLog?.(`Local scan: ${this.cache.hits} cached, ${this.cache.hashed} hashed; ${localFinished - started} ms.\n`);
            const remote = await this.collectRemote(client, filter, options.files, options);
            options.onLog?.(`Remote scan: ${remote.size} entries; ${Date.now() - localFinished} ms.\n`);
            await this.saveCache(options);
            options.onState?.({ phase: 'Comparing files' });
            plan = this.buildPlan(local, remote, state).filter((item) => !options.files || options.files.some((file) => file === item.file
                || (item.action === 'conflict' && file.startsWith(`${item.file}/`))));
        }
        const conflicts = plan.filter((item) => item.action === 'conflict'),
            changes = plan.filter((item) => !['conflict', 'unchanged'].includes(item.action)),
            report = [
                `Upload: ${plan.filter((item) => item.action === 'upload').length}`,
                `Download: ${plan.filter((item) => item.action === 'download').length}`,
                `Create dirs: ${plan.filter((item) => item.action.startsWith('mkdir')).length}`,
                `Conflicts: ${conflicts.length}`,
                'Automatic deletion: disabled',
            ].join('\n');
        for (const item of conflicts) { options.onLog?.(`${describe(item)}\n`); }
        if (options.dryRun) {
            preparedPlan = { key, id: randomUUID(), createdAt: Date.now(), items: plan };
            options.onState?.({ phase: 'Plan ready', planId: preparedPlan.id, total: changes.filter((item) => item.action === 'upload' || item.action === 'download').length });
            options.onLog?.('Plan valid for 30 minutes. New paths added after this preview require a new Dry Run.\n');
            for (const item of changes) { options.onLog?.(`PLAN ${describe(item)}\n`); }
            return `DRY RUN${conflicts.length ? ' WITH CONFLICTS' : ''}\n${report}`;
        }

        for (const item of plan.filter((entry) => entry.action === 'unchanged' && !entry.local!.isDirectory)) {
            state.records.set(item.file, { local: item.local!, remote: item.remote! });
        }
        let completed = 0, completedFiles = 0, completedBytes = 0;
        const totalFiles = changes.filter((item) => item.action === 'download' || item.action === 'upload').length,
            totalBytes = changes.reduce((sum, item) => sum + (item.action === 'download' ? item.remote!.size : item.action === 'upload' ? item.local!.size : 0), 0);
        options.onState?.({ phase: 'Transferring files', current: 0, total: totalFiles, completedBytes: 0, totalBytes, percent: 0 });
        const perform = async (item: PlannedFile) => {
            options.onState?.({ file: item.file });
            options.onLog?.(`${describe(item)} — started\n`);
            try {
                await this.execute(client, item, state);
                completed += 1;
                if (item.action === 'upload' || item.action === 'download') { completedFiles++; }
                completedBytes += item.action === 'download' ? item.remote!.size : item.action === 'upload' ? item.local!.size : 0;
                options.onState?.({ current: completedFiles, total: totalFiles, completedBytes, totalBytes,
                    percent: Math.min(99, Math.floor(100 * (totalBytes ? completedBytes / totalBytes : completed / changes.length))), file: item.file });
                options.onProgress?.(completed, changes.length, item.file, item.action);
                options.onLog?.(`${describe(item)} — done\n`);
            } catch (error: any) {
                options.onLog?.(`${describe(item)} — failed: ${error.message}\n`);
                throw error;
            }
        };
        try {
            if (changes.some((item) => item.action === 'upload' || item.action === 'mkdirRemote')) {
                await client.mkdir(this.config.remotePath!);
            }
            // Parent directories must exist before any file transfer begins.
            for (const item of changes.filter((entry) => entry.action.startsWith('mkdir'))) { await perform(item); }
            const transfers = changes.filter((entry) => !entry.action.startsWith('mkdir')),
                concurrency = transferConcurrency(this.config.concurrency);
            let next = 0, failed = false;
            const worker = async () => {
                while (!failed && next < transfers.length) {
                    const item = transfers[next++];
                    try { await perform(item); }
                    catch (error) { failed = true; throw error; }
                }
            },
                results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, transfers.length) }, worker)),
                failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) { throw failure.reason; }
        } finally { await state.save(); await this.saveCache(options); }
        const result = `${conflicts.length ? 'SYNC FINISHED WITH CONFLICTS' : 'SYNC COMPLETE'}\n${report}`;
        if (conflicts.length) {
            return `${result}\n${conflicts.map(describe).join('\n')}\nResolve each conflict with Upload Active File or Download Active File after choosing the version to keep.`;
        }
        return result;
    }

    /** Upload local changes only; never traverse or download the remote tree. */
    async uploadChanged(client: RemoteClient, options: SyncOptions = {}): Promise<string> {
        preparedPlan = undefined;
        const state = new SyncState(this.config), filter = ignore().add(this.config.ignore ?? []).add(SYNC_EXCLUDES);
        await state.load();
        this.cache = new ScanCache(this.config.localPath!);
        await this.cache.load();
        const local = await this.collectLocal(filter, undefined, options),
            candidates = [...local].filter(([file, entry]) => !entry.isDirectory && !entry.isSymbolicLink
                && !sameLocal(entry, state.records.get(file)?.local));
        let next = 0, completed = 0, failed = false;
        options.onState?.({ phase: 'Uploading local changes', current: 0, total: candidates.length, percent: 0 });
        options.onLog?.(`Local changes: ${candidates.length}; no recursive remote scan.\n`);
        const worker = async () => {
            while (!failed && next < candidates.length) {
                const [file, entry] = candidates[next++];
                try {
                    // Check only this destination and its parents; local content is authoritative.
                    let parent = path.posix.dirname(file);
                    while (parent !== '.') {
                        const target = await client.stat(path.posix.join(this.config.remotePath!, parent));
                        if (target && (!target.isDirectory || target.isSymbolicLink)) {
                            throw new Error(`Unsafe remote parent: ${parent}`);
                        }
                        parent = path.posix.dirname(parent);
                    }
                    const remote = await client.stat(path.posix.join(this.config.remotePath!, file));
                    if (remote?.isDirectory || remote?.isSymbolicLink) { throw new Error(`Not a regular remote file: ${file}`); }
                    if (!state.records.has(file) && remote && sameMetadata(entry, remote)) {
                        state.records.set(file, { local: entry, remote });
                    } else {
                        options.onLog?.(`UPLOAD local to server: ${file} — started\n`);
                        await this.execute(client, { file, action: 'upload', local: entry, remote }, state);
                        options.onLog?.(`UPLOAD local to server: ${file} — done\n`);
                    }
                    completed++;
                    options.onState?.({ file, current: completed, percent: Math.min(99, Math.floor(100 * completed / candidates.length)) });
                } catch (error: any) {
                    failed = true;
                    options.onLog?.(`UPLOAD local to server: ${file} — failed: ${error.message}\n`);
                    throw error;
                }
            }
        };
        try {
            const results = await Promise.allSettled(Array.from({ length: Math.min(transferConcurrency(this.config.concurrency), candidates.length) }, worker)),
                failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) { throw failure.reason; }
        } finally { await state.save(); await this.saveCache(options); }
        return `UPLOAD COMPLETE\nLocal changes processed: ${completed}\nDownload: 0\nAutomatic deletion: disabled`;
    }

    /** Explicit user choice resolves a conflict and records the selected pair. */
    async transferFile(client: RemoteClient, file: string, action: 'upload' | 'download'): Promise<void> {
        await this.assertLocalPath(file);
        const local = await fingerprintLocal(path.join(this.config.localPath!, file)),
            remote = await client.stat(path.posix.join(this.config.remotePath!, file)),
            state = new SyncState(this.config);
        if (remote?.isDirectory || remote?.isSymbolicLink) { throw new Error(`Not a regular remote file: ${file}`); }
        if ((action === 'upload' && !local) || (action === 'download' && !remote)) { throw new Error(`Source file is missing: ${file}`); }
        await state.load();
        await this.execute(client, { file, action, local: local ? { ...local, isDirectory: false } : undefined, remote }, state);
        await state.save();
    }

    private async collectLocal(filter: ReturnType<typeof ignore>, selected?: string[], options: SyncOptions = {}): Promise<Map<string, Entry>> {
        let directories = 0, files = 0;
        const entries = new Map<string, Entry>(),
            walk = async (relative: string) => {
                options.onState?.({ phase: 'Scanning local files', directories: ++directories, localFiles: files, file: relative || '.' });
                for (const item of await fs.promises.readdir(path.join(this.config.localPath!, relative), { withFileTypes: true })) {
                    const file = relative ? `${relative}/${item.name}` : item.name;
                    if (filter.ignores(file) || (selected && !selected.some((target) => target === file || target.startsWith(`${file}/`)))) { continue; }
                    const full = path.join(this.config.localPath!, file),
                        stat = await fs.promises.lstat(full),
                        regular = stat.isFile() && !stat.isSymbolicLink(),
                        fingerprint = regular ? await this.cache!.fingerprint(file, this.config.verifyContents) : { size: stat.size, modifyTime: stat.mtimeMs };
                    if (!fingerprint) { throw new Error(`File disappeared while scanning: ${file}`); }
                    if (regular) { files++; }
                    options.onState?.({ localFiles: files, file, cachedFiles: this.cache!.hits, hashedFiles: this.cache!.hashed });
                    entries.set(file, { ...fingerprint, isDirectory: stat.isDirectory(),
                        isSymbolicLink: !regular && !stat.isDirectory() });
                    if (stat.isDirectory()) { await walk(file); }
                }
            };
        await walk('');
        if (!selected) { this.cache!.prune(entries.keys()); }
        return entries;
    }

    private async saveCache(options: SyncOptions): Promise<void> {
        try { await this.cache?.save(); }
        catch (error: any) { options.onLog?.(`Local scan cache could not be saved: ${error.message}\n`); }
    }

    private async collectRemote(client: RemoteClient, filter: ReturnType<typeof ignore>, selected?: string[], options: SyncOptions = {}): Promise<Map<string, Entry>> {
        let directories = 0, files = 0;
        const entries = new Map<string, Entry>(), pending = [''], concurrency = transferConcurrency(this.config.scanConcurrency),
            visit = async (relative: string) => {
                options.onState?.({ phase: 'Scanning remote files', file: relative || '.' });
                const items = await client.list(path.posix.join(this.config.remotePath!, relative));
                for (const item of items) {
                    if (item.name === '.' || item.name === '..') { continue; }
                    if (!item.name || /[/\\\0]/.test(item.name) || /^[a-z]:/i.test(item.name)) {
                        throw new Error(`Unsafe remote filename: ${JSON.stringify(item.name)}`);
                    }
                    const file = relative ? `${relative}/${item.name}` : item.name;
                    if (filter.ignores(file) || (selected && !selected.some((target) => target === file || target.startsWith(`${file}/`)))) { continue; }
                    if (!item.isDirectory) { files++; }
                    entries.set(file, item);
                    if (item.isDirectory && !item.isSymbolicLink) { pending.push(file); }
                }
                options.onState?.({ directories: ++directories, remoteFiles: files, file: relative || '.' });
            };
        while (pending.length) {
            // Drain every in-flight request on failure before the owner closes the clients.
            const results = await Promise.allSettled(pending.splice(0, concurrency).map(visit)),
                failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) { throw failure.reason; }
        }
        return entries;
    }

    private buildPlan(local: Map<string, Entry>, remote: Map<string, Entry>, state: SyncState): PlannedFile[] {
        const files = [...new Set([...local.keys(), ...remote.keys()])].sort(),
            plan: PlannedFile[] = [],
            blocked: string[] = [];
        for (const file of files) {
            if (blocked.some((parent) => file.startsWith(`${parent}/`))) { continue; }
            const left = local.get(file),
                right = remote.get(file),
                previous = state.records.get(file),
                item: PlannedFile = { file, local: left, remote: right, action: 'unchanged' };
            if (left?.isSymbolicLink || right?.isSymbolicLink || (left && right && left.isDirectory !== right.isDirectory)) {
                item.action = 'conflict';
                item.reason = 'symbolic link, unsupported file type or file/directory mismatch';
                blocked.push(file);
            } else if (!left) {
                item.action = right!.isDirectory ? 'mkdirLocal' : 'download';
            } else if (!right) {
                item.action = left.isDirectory ? 'mkdirRemote' : 'upload';
            } else if (!left.isDirectory) {
                if (previous) {
                    const localChanged = !sameLocal(left, previous.local),
                        remoteChanged = !sameMetadata(right, previous.remote);
                    item.action = localChanged && remoteChanged ? 'conflict'
                        : localChanged ? 'upload' : remoteChanged ? 'download' : 'unchanged';
                    if (item.action === 'conflict') { item.reason = 'both copies changed since the last successful sync'; }
                } else if (left.modifyTime > 0 && right.modifyTime > 0
                    && Math.floor(left.modifyTime / 1000) !== Math.floor(right.modifyTime / 1000)) {
                    item.action = left.modifyTime > right.modifyTime ? 'upload' : 'download';
                } else if (!sameMetadata(left, right) || !left.modifyTime || !right.modifyTime) {
                    item.action = 'conflict';
                    item.reason = 'cannot determine the newer version';
                }
            }
            plan.push(item);
        }
        return plan;
    }

    private async assertLocalPath(file: string): Promise<void> {
        let current = this.config.localPath!;
        for (const part of file.split('/')) {
            current = path.join(current, part);
            try {
                if ((await fs.promises.lstat(current)).isSymbolicLink()) { throw new Error(`Symbolic link blocks synchronization: ${file}`); }
            } catch (error: any) { if (error.code !== 'ENOENT') { throw error; } }
        }
    }

    private async validatePreparedPlan(client: RemoteClient, plan: PlannedFile[], options: SyncOptions): Promise<void> {
        const concurrency = transferConcurrency(this.config.scanConcurrency);
        for (let offset = 0; offset < plan.length; offset += concurrency) {
            const results = await Promise.allSettled(plan.slice(offset, offset + concurrency).map(async (item) => {
                options.onState?.({ file: item.file });
                if (item.action === 'conflict') { return; }
                if (item.local?.isDirectory || item.remote?.isDirectory) { await this.assertDirectoryUnchanged(client, item); }
                else { await this.assertUnchanged(client, item, true); }
            })), failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) { throw failure.reason; }
            options.onState?.({ cachedFiles: this.cache!.hits, hashedFiles: this.cache!.hashed });
        }
    }

    private async assertUnchanged(client: RemoteClient, item: PlannedFile, useCache = false): Promise<void> {
        await this.assertLocalPath(item.file);
        const local = useCache ? await this.cache!.fingerprint(item.file, this.config.verifyContents)
                : await fingerprintLocal(path.join(this.config.localPath!, item.file)),
            remote = await client.stat(path.posix.join(this.config.remotePath!, item.file));
        if (!sameLocal(local, item.local) || !sameMetadata(remote, item.remote) || remote?.isDirectory || remote?.isSymbolicLink) {
            throw new Error(`File changed after scanning; run sync again: ${item.file}`);
        }
    }

    private async assertDirectoryUnchanged(client: RemoteClient, item: PlannedFile): Promise<void> {
        await this.assertLocalPath(item.file);
        let local: fs.Stats | undefined;
        try { local = await fs.promises.lstat(path.join(this.config.localPath!, item.file)); }
        catch (error: any) { if (error.code !== 'ENOENT') { throw error; } }
        const remote = await client.stat(path.posix.join(this.config.remotePath!, item.file));
        if (!!local !== !!item.local || !!remote !== !!item.remote
            || (local && (!local.isDirectory() || local.isSymbolicLink()))
            || (remote && (!remote.isDirectory || remote.isSymbolicLink))) {
            throw new Error(`Directory changed after scanning; run Dry Run again: ${item.file}`);
        }
    }

    private async execute(client: RemoteClient, item: PlannedFile, state: SyncState): Promise<void> {
        const local = path.join(this.config.localPath!, item.file),
            remote = path.posix.join(this.config.remotePath!, item.file);
        await this.assertLocalPath(item.file);
        if (item.action.startsWith('mkdir')) { await this.assertDirectoryUnchanged(client, item); }
        if (item.action === 'mkdirLocal') { await fs.promises.mkdir(local, { recursive: true }); return; }
        if (item.action === 'mkdirRemote') { await client.mkdir(remote); return; }
        await this.assertUnchanged(client, item);
        if (item.action === 'download') {
            const staging = await state.stageDownload(), temporary = staging.file;
            try {
                await client.get(remote, temporary);
                const downloaded = await fs.promises.lstat(temporary);
                if (!downloaded.isFile() || downloaded.size !== item.remote!.size) { throw new Error(`Incomplete download: ${item.file}`); }
                await this.assertUnchanged(client, item);
                await fs.promises.mkdir(path.dirname(local), { recursive: true });
                if (item.remote!.modifyTime > 0) {
                    await fs.promises.utimes(temporary, new Date(), new Date(item.remote!.modifyTime));
                }
                await fs.promises.rename(temporary, local);
            } finally { await staging.dispose(); }
        } else {
            await client.put(local, remote);
        }
        const afterLocal = await fingerprintLocal(local),
            afterRemote: RemoteItem | undefined = await client.stat(remote);
        if (!afterLocal || !afterRemote || afterRemote.isDirectory || afterRemote.size !== afterLocal.size
            || (item.action === 'upload' && !sameLocal(afterLocal, item.local))
            || (item.action === 'download' && !sameMetadata(afterRemote, item.remote))) {
            throw new Error(`File changed during transfer; sync history was not updated: ${item.file}`);
        }
        this.cache?.remember(item.file, afterLocal);
        state.records.set(item.file, { local: afterLocal, remote: { size: afterRemote.size, modifyTime: afterRemote.modifyTime } });
    }
}
