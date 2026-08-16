export function getFilledCount(percent: number, total: number): number {
    const clamped = Math.max(0, Math.min(100, percent));
    return Math.round((clamped / 100) * total);
}

export function renderProgress(percent: number, total = 10): string {
    const filled = getFilledCount(percent, total),
        full = '\u2588',
        empty = '\u2591',
        bar = full.repeat(filled) + empty.repeat(total - filled);
    const clamped = Math.max(0, Math.min(100, percent));
    return `${bar} ${clamped}%`;
}
