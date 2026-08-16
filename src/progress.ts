/**
 * Calculates the number of filled progress bar segments for a percentage.
 * @param percent - The percentage value.
 * @param total - The total number of segments.
 * @returns {number} The number of filled segments.
 */
export function getFilledCount(percent: number, total: number): number {
    const clamped = Math.max(0, Math.min(100, percent));
    return Math.round((clamped / 100) * total);
}

/**
 * Renders a textual progress bar for the given percentage.
 * @param percent - The percentage value.
 * @param total - The total number of bar segments (defaults to 10).
 * @returns {string} The rendered progress bar string.
 */
export function renderProgress(percent: number, total = 10): string {
    const filled = getFilledCount(percent, total),
        full = '\u2588',
        empty = '\u2591',
        bar = full.repeat(filled) + empty.repeat(total - filled);
    const clamped = Math.max(0, Math.min(100, percent));
    return `${bar} ${clamped}%`;
}
