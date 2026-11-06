/** Coalesces changes and retries temporary failures without overlapping transfers. */
export class SaveUploadQueue {
    private timer?: NodeJS.Timeout;
    private pending = false;
    private running = false;
    private disposed = false;
    private attempts = 0;
    /** Creates a queue with bounded exponential retry delays. */
    constructor(private readonly run: () => Promise<void>, private readonly busy: () => boolean,
        private readonly onError: (error: unknown) => void, private readonly delay: () => number,
        private readonly retryDelay = 1000, private readonly retryLimit = 3) {}
    /** Requests a fresh attempt, including when a previous retry budget was exhausted. */
    request(): void {
        if (this.disposed) { return; }
        this.attempts = 0;
        this.pending = true;
        this.schedule(this.delay());
    }
    /** Replaces the pending timer without starting overlapping work. */
    private schedule(delay: number): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => { void this.flush(); }, delay);
    }
    /** Runs one batch and retains failed work for bounded retries or a manual request. */
    private async flush(): Promise<void> {
        this.timer = undefined;
        if (this.disposed || !this.pending || this.running) { return; }
        if (this.busy()) { this.schedule(this.delay()); return; }
        this.pending = false;
        this.running = true;
        let wait = this.delay();
        try { await this.run(); this.attempts = 0; }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error),
                temporary = /offline|ECONN|ETIMEDOUT|EPIPE|connection.*(?:lost|reset|closed|error)|socket|temporarily unavailable|File changed|status 255/i.test(message);
            if (temporary && !/x509|certificate|permission denied|authentication|Transfer cancelled/i.test(message) && this.attempts < this.retryLimit) {
                wait = this.retryDelay * 2 ** this.attempts++;
                this.pending = true;
            } else { this.pending = false; this.onError(error); }
        } finally {
            this.running = false;
            if (this.pending && !this.disposed) { this.schedule(wait); }
        }
    }
    /** Stops timers and prevents an in-flight operation from scheduling more work. */
    dispose(): void {
        this.disposed = true;
        this.pending = false;
        if (this.timer) { clearTimeout(this.timer); }
    }
}
