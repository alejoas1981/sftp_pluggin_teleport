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
    uploadActive?: boolean;
    downloadActive?: boolean;
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

type LogLevel = 'ok' | 'error' | 'warning';

interface TransferLine {
    text: string;
    level?: LogLevel;
}

const transferLogLimit = 2000;

/** Extension-owned state. Observer failure can never fail the synchronization. */
export class SyncTask {
    private state?: Omit<TaskSnapshot, 'logs'>;
    private readonly logLines: TransferLine[] = [];
    private nextLogLine = 0;
    private logNotificationScheduled = false;
    private readonly logListeners = new Set<() => void>();
    private readonly listeners = new Set<(state: TaskSnapshot) => void>();
    private timer?: ReturnType<typeof setInterval>;

    private resetTimer?: ReturnType<typeof setTimeout>;
    private timingUpdatedAt = 0;

    constructor(private readonly completionDisplayMs = 1500) {}

    snapshot(): TaskSnapshot | undefined {
        return this.state ? { ...this.state, logs: this.logLines.map(({ text }) => text) } : undefined;
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
            directories: 0, uploadMs: 0, downloadMs: 0, uploadActive: false, downloadActive: false,
            file: '' };
        this.timingUpdatedAt = this.state.startedAt;
        this.publish();
        this.timer = setInterval(() => this.publish(), 250);
        this.timer.unref?.();
    }

    update(progress: Partial<SyncProgress>): void {
        if (this.state) {
            this.advanceTransferTimings();
            Object.assign(this.state, progress);
        }
    }

    /** Appends individual console lines and discards the oldest overflow. */
    log(text: string, level?: LogLevel): void {
        if (!text) { return; }
        const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
        this.nextLogLine += lines.length;
        this.logLines.push(...lines.slice(-transferLogLimit).map((line) => ({ text: line, level })));
        if (this.logLines.length > transferLogLimit) {
            this.logLines.splice(0, this.logLines.length - transferLogLimit);
        }
        if (this.logNotificationScheduled) { return; }
        this.logNotificationScheduled = true;
        queueMicrotask(() => {
            this.logNotificationScheduled = false;
            for (const listener of this.logListeners) {
                try { listener(); }
                catch { this.logListeners.delete(listener); }
            }
        });
    }

    /** Subscribes to changes in the shared console history. */
    subscribeLog(listener: () => void): () => void {
        this.logListeners.add(listener);
        return () => this.logListeners.delete(listener);
    }

    /** Returns retained lines not yet sent to the panel and the absolute position of the first. */
    logSnapshot(from = 0): { start: number; lines: TransferLine[] } {
        const oldest = this.nextLogLine - this.logLines.length,
            start = Math.max(oldest, Math.min(from, this.nextLogLine));
        return { start, lines: this.logLines.slice(start - oldest) };
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
        this.advanceTransferTimings();
        this.state.elapsedMs = Date.now() - this.state.startedAt;
        const timedResult = `${result}\nSession time: ${this.state.elapsedMs} ms\nUpload time: ${this.state.uploadMs} ms\nDownload time: ${this.state.downloadMs} ms`;
        this.log(timedResult, error ? 'error' : warning || result.includes('WITH CONFLICTS') ? 'warning' : 'ok');
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
        this.logListeners.clear();
    }

    private publish(updateElapsed = true): void {
        if (!this.state) { return; }
        this.advanceTransferTimings();
        if (updateElapsed) { this.state.elapsedMs = Date.now() - this.state.startedAt; }
        for (const listener of this.listeners) {
            try { listener(this.snapshot()!); }
            catch { /* A disposed observer is detached; transfer state remains owned here. */ this.listeners.delete(listener); }
        }
    }

    /** Advances live direction timers since the previous state update. */
    private advanceTransferTimings(): void {
        if (!this.state) { return; }
        const now = Date.now(), elapsed = Math.max(0, now - this.timingUpdatedAt);
        if (this.state.uploadActive) { this.state.uploadMs += elapsed; }
        if (this.state.downloadActive) { this.state.downloadMs += elapsed; }
        this.timingUpdatedAt = now;
    }
}
