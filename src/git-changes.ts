import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const git = promisify(execFile);

/**
 * Lists paths added or modified between two observed revisions.
 * Git emits NUL separators so spaces and newlines in paths are preserved.
 */
export async function changedGitPaths(root: string, before: string, after: string, signal: AbortSignal): Promise<string[]> {
    const { stdout } = await git('git', [
        'diff', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', before, after, '--'
    ], { cwd: root, signal, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).map((file) => path.join(root, file));
}
