/** Coalesce save bursts, retaining a follow-up request during an active transfer. */
export class SaveUploadQueue {
    private timer?: NodeJS.Timeout;
    private pending = false;
    private running = false;
    private disposed = false;
    constructor(private readonly run: () => Promise<void>, private readonly busy: () => boolean,
        private readonly onError: (error: unknown) => void, private readonly delay: () => number) {}
    request(): void {
        if (this.disposed) { return; }
        this.pending = true;
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => { void this.flush(); }, this.delay());
    }
    private async flush(): Promise<void> {
        this.timer = undefined;
        if (this.disposed || !this.pending || this.running) { return; }
        if (this.busy()) { this.request(); return; }
        this.pending = false;
        this.running = true;
        try { await this.run(); }
        catch (error) { this.onError(error); }
        finally {
            this.running = false;
            if (this.pending) { this.request(); }
        }
    }
    dispose(): void {
        this.disposed = true;
        this.pending = false;
        if (this.timer) { clearTimeout(this.timer); }
    }
}
