/**
 * Remote file system entry metadata.
 */
export interface RemoteItem {
    /** Entry name without parent path. */
    name: string;
    /** Size in bytes. */
    size: number;
    /** Last modification time in milliseconds since the Unix epoch. */
    modifyTime: number;
    /** True when the entry is a directory. */
    isDirectory: boolean;
}

/**
 * Abstraction over FTP, SFTP and Teleport remote access.
 */
export interface RemoteClient {
    /**
     * Verifies the remote connection is reachable.
     * @returns {Promise<void>}
     */
    test(): Promise<void>;

    /**
     * Lists the contents of a remote directory.
     * @param remoteDir - The remote directory path.
     * @returns {Promise<RemoteItem[]>} The directory entries.
     */
    list(remoteDir: string): Promise<RemoteItem[]>;

    /**
     * Gets metadata for a remote file or directory.
     * @param remotePath - The remote path to inspect.
     * @returns {Promise<RemoteItem | undefined>} The remote item, or undefined if missing.
     */
    stat(remotePath: string): Promise<RemoteItem | undefined>;

    /**
     * Uploads a local file to the remote server.
     * @param localPath - The local file path.
     * @param remotePath - The remote destination path.
     * @returns {Promise<void>}
     */
    put(localPath: string, remotePath: string): Promise<void>;

    /**
     * Downloads a remote file to the local path.
     * @param remotePath - The remote file path.
     * @param localPath - The local destination path.
     * @returns {Promise<void>}
     */
    get(remotePath: string, localPath: string): Promise<void>;

    /**
     * Creates a directory on the remote server.
     * @param remotePath - The remote directory path to create.
     * @returns {Promise<void>}
     */
    mkdir(remotePath: string): Promise<void>;

    /**
     * Deletes a remote file or directory.
     * @param remotePath - The remote path to delete.
     * @returns {Promise<void>}
     */
    delete(remotePath: string): Promise<void>;

    /**
     * Closes the underlying remote connection.
     * @returns {Promise<void>}
     */
    close(): Promise<void>;
}
