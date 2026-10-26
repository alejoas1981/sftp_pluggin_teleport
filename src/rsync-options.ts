import type { SftpConfig } from './config';

/** Parse configuration arguments as data, never through a shell. */
function tokens(input: string): string[] {
    const result: string[] = [];
    let token = '', quote = '', started = false;
    for (let i = 0; i < input.length; i++) {
        const character = input[i];
        if (character === '\\' && quote !== "'") {
            if (++i === input.length) { throw new Error('Incomplete escape in Extra Rsync Flags'); }
            token += input[i]; started = true;
        } else if (quote) {
            if (character === quote) { quote = ''; } else { token += character; }
        } else if (character === "'" || character === '"') {
            quote = character; started = true;
        } else if (/\s/.test(character)) {
            if (started) { result.push(token); token = ''; started = false; }
        } else { token += character; started = true; }
    }
    if (quote) { throw new Error('Unclosed quote in Extra Rsync Flags'); }
    if (started) { result.push(token); }
    return result;
}

/** Keep legacy rsync exclusions in the shared planner, not only in rsync. */
export function normalizeRsyncOptions(config: SftpConfig): SftpConfig {
    const teleport = config.mode ? config.mode === 'teleport' : config.useTeleport !== false && !!config.teleportHost;
    if (!teleport) { return config; }
    const args = tokens(config.rsyncFlags ?? ''), exclusions = [...(config.ignore ?? [])], flags: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const argument = args[i];
        if (/^--bwlimit=\d+$/.test(argument)) { flags.push(argument); continue; }
        let pattern: string;
        if (argument === '--exclude') { pattern = args[++i]; }
        else if (argument.startsWith('--exclude=')) { pattern = argument.slice('--exclude='.length); }
        else { throw new Error(`Unsupported Extra Rsync Flags argument: ${argument}. Supported: --exclude PATTERN, --exclude=PATTERN, --bwlimit=N.`); }
        if (!pattern || pattern.startsWith('--')) { throw new Error('Missing pattern after --exclude in Extra Rsync Flags'); }
        // Non-rooted rsync paths can match at any depth; protect literal ! and #.
        if (!pattern.startsWith('/') && pattern.replace(/\/$/, '').includes('/')) { pattern = '**/' + pattern; }
        if (/^[!#]/.test(pattern)) { pattern = '\\' + pattern; }
        exclusions.push(pattern);
    }
    return { ...config, ignore: [...new Set(exclusions)], rsyncFlags: flags.join(' ') };
}
