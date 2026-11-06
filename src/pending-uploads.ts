import { createHash } from 'crypto';
import { SftpConfig, resolveMode } from './config';

interface Storage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

/** Stores versioned pending paths separately for each workspace destination. */
export class PendingUploads {
    private readonly queues = new Map<string, Map<string, number>>();
    private sequence = 0;
    private writes: Promise<void> = Promise.resolve();
    /** Binds the journal to VS Code workspace storage. */
    constructor(private readonly storage: Storage) {}
    /** Returns the queue for this exact local and remote destination. */
    entries(config: SftpConfig): Map<string, number> {
        const key = this.key(config);
        let queue = this.queues.get(key);
        if (!queue) {
            queue = new Map((this.storage.get<string[]>(key) ?? []).filter((file) => typeof file === 'string')
                .map((file) => [file, ++this.sequence]));
            this.queues.set(key, queue);
        }
        return queue;
    }
    /** Records the latest observed file version and persists its path. */
    record(config: SftpConfig, file: string): Promise<void> {
        this.entries(config).set(file, ++this.sequence);
        return this.persist(config);
    }
    /** Removes only versions successfully handled by the supplied batch. */
    acknowledge(config: SftpConfig, batch: Map<string, number>): Promise<void> {
        const queue = this.entries(config);
        for (const [file, sequence] of batch) {
            if (queue.get(file) === sequence) { queue.delete(file); }
        }
        return this.persist(config);
    }
    /** Waits until all recorded paths are durable before starting a transfer. */
    async flush(): Promise<void> { await this.writes; }
    /** Serializes snapshots so an older write cannot replace newer pending paths. */
    private persist(config: SftpConfig): Promise<void> {
        const key = this.key(config), files = [...this.entries(config).keys()];
        this.writes = this.writes.catch(() => {}).then(() => this.storage.update(key, files));
        return this.writes;
    }
    /** Hashes connection identity without storing passwords or other credentials. */
    private key(config: SftpConfig): string {
        return 'pendingUploads.' + createHash('sha256').update(JSON.stringify([
            config.localPath, resolveMode(config), config.ftpHost, config.ftpPort, config.ftpUser,
            config.sftpHost, config.sftpPort, config.sftpUser, config.remotePath,
            config.teleportHost, config.teleportUser, config.teleportCluster,
        ])).digest('hex');
    }
}
