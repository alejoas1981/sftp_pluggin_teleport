import { randomUUID } from 'crypto';

export interface SyncProgress {
    phase: string;
    current: number;
    total?: number;
    completedBytes: number;
    totalBytes?: number;
    cachedFiles?: number;
    hashedFiles?: number;
    localFiles: number;
    remoteFiles: number;
    directories: number;
    /** Wall-clock milliseconds spent in active upload operations. */
    uploadMs: number;
    /** Wall-clock milliseconds spent in active download operations. */
    downloadMs: number;
    file: string;
    percent?: number;
    planId?: string;
}

export interface TaskSnapshot extends SyncProgress {
    id: string;
    dryRun: boolean;
    status: 'running' | 'complete' | 'warning' | 'error';
    startedAt: number;
    elapsedMs: number;
    logs: string[];
    result?: string;
    progressReset?: boolean;
}

/** Extension-owned state. Observer failure can never fail the synchronization. */
export class SyncTask {
    private state?: TaskSnapshot;
    private readonly listeners = new Set<(state: TaskSnapshot) => void>();
    private timer?: ReturnType<typeof setInterval>;

    private resetTimer?: ReturnType<typeof setTimeout>;

    constructor(private readonly completionDisplayMs = 1500) {}

    snapshot(): TaskSnapshot | undefined {
        return this.state ? { ...this.state, logs: [...this.state.logs] } : undefined;
    }

    subscribe(listener: (state: TaskSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    start(dryRun: boolean): void {
        if (this.state?.status === 'running') { throw new Error('Sync already in progress'); }
        clearTimeout(this.resetTimer);
        this.state = { id: randomUUID(), dryRun, status: 'running', startedAt: Date.now(), elapsedMs: 0,
            phase: 'Connecting', current: 0, completedBytes: 0, localFiles: 0, remoteFiles: 0,
            directories: 0, uploadMs: 0, downloadMs: 0, file: '', logs: [] };
        this.publish();
        this.timer = setInterval(() => this.publish(), 250);
        this.timer.unref?.();
    }

    update(progress: Partial<SyncProgress>): void {
        if (this.state) { Object.assign(this.state, progress); }
    }

    log(text: string): void {
        if (!this.state) { return; }
        this.state.logs.push(text.slice(-2000));
        if (this.state.logs.length > 500) { this.state.logs.shift(); }
    }

    /**
     * Completes the active task and appends stable timing metrics to its log.
     * @param result - Human-readable operation result.
     * @param error - Whether the operation failed.
     * @param warning - Whether the operation completed with a recoverable warning.
     * @returns {void}
     */
    finish(result: string, error = false, warning = false): void {
        if (!this.state) { return; }
        clearInterval(this.timer);
        this.timer = undefined;
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        const timedResult = `${result}\nSession time: ${this.state.elapsedMs} ms\nUpload time: ${this.state.uploadMs} ms\nDownload time: ${this.state.downloadMs} ms`;
        this.log(timedResult + '\n');
        Object.assign(this.state, { result,
            status: error ? 'error' : warning || result.includes('WITH CONFLICTS') ? 'warning' : 'complete',
            phase: error ? this.state.phase + ' — failed' : warning ? 'Restarting upload'
                : this.state.dryRun ? 'Analysis complete' : 'Sync complete',
            percent: error ? this.state.percent : 100 });
        this.publish();
        clearTimeout(this.resetTimer);
        if (this.state.status === 'complete') {
            const id = this.state.id;
            this.resetTimer = setTimeout(() => {
                if (this.state?.id !== id || this.state.status !== 'complete') { return; }
                this.state.progressReset = true;
                this.publish(false);
            }, this.completionDisplayMs);
            this.resetTimer.unref?.();
        }
    }

    dispose(): void {
        clearTimeout(this.resetTimer);
        clearInterval(this.timer);
        this.listeners.clear();
    }

    private publish(updateElapsed = true): void {
        if (!this.state) { return; }
        if (updateElapsed) { this.state.elapsedMs = Date.now() - this.state.startedAt; }
        for (const listener of this.listeners) {
            try { listener(this.snapshot()!); }
            catch { /* A disposed observer is detached; transfer state remains owned here. */ this.listeners.delete(listener); }
        }
    }
}
