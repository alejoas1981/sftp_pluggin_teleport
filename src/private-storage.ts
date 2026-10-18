import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

let storageRoot: string | undefined, workspaceRoots: string[] = [];

export function configureStorage(root: string, workspaces: string[] = []): void {
    storageRoot = canonicalPath(root);
    workspaceRoots = workspaces.map(canonicalPath);
}

export function canonicalPath(file: string): string {
    try { return fs.realpathSync(file); }
    catch (error: any) {
        if (error.code !== 'ENOENT') { throw error; }
        const absolute = path.resolve(file), parent = path.dirname(absolute);
        return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
    }
}

function contains(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function projectStorage(localRoot: string): string {
    if (!storageRoot) { throw new Error('Extension storage has not been initialized'); }
    const root = canonicalPath(localRoot), storage = canonicalPath(storageRoot);
    if ([root, ...workspaceRoots].some((project) => contains(project, storage))) {
        throw new Error('Extension storage must be outside the project and workspace');
    }
    return path.join(storageRoot, 'sync', createHash('sha256').update(root).digest('hex'));
}

export async function readPrivateFile(file: string): Promise<string | undefined> {
    try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error(`Unsafe extension storage file: ${path.basename(file)}`); }
        return await fs.promises.readFile(file, 'utf8');
    } catch (error: any) { if (error.code === 'ENOENT') { return undefined; } throw error; }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Unsafe extension storage directory'); }
}

export async function writePrivateFile(file: string, content: string): Promise<void> {
    const directory = path.dirname(file), temporary = path.join(directory, `${randomUUID()}.tmp`);
    await ensurePrivateDirectory(directory);
    try {
        await fs.promises.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temporary, file);
    } finally { await fs.promises.rm(temporary, { force: true }); }
}

/** A rename must stay on one filesystem. Never fall back to truncating the destination. */
export async function stageDownload(directory: string, localRoot: string): Promise<{ file: string; dispose: () => Promise<void> }> {
    await ensurePrivateDirectory(directory);
    const root = canonicalPath(localRoot),
        localStat = await fs.promises.stat(root),
        storageStat = await fs.promises.stat(directory);
    let base = directory;
    if (localStat.dev !== storageStat.dev) {
        let boundary = root, ancestor = root;
        for (const workspace of workspaceRoots) { if (contains(workspace, boundary)) { boundary = workspace; } }
        while (true) {
            if (fs.existsSync(path.join(ancestor, '.git')) && contains(ancestor, boundary)) { boundary = ancestor; }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) { break; }
            ancestor = parent;
        }
        base = path.dirname(boundary);
        if (contains(boundary, base) || (await fs.promises.stat(base)).dev !== localStat.dev) {
            throw new Error('Cannot stage an atomic download outside the project on this filesystem; use a project subdirectory on this volume');
        }
    }
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(base, '.sftp-transfer-'));
    return { file: path.join(temporaryDirectory, 'download'),
        dispose: () => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }) };
}
