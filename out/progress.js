"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFilledCount = getFilledCount;
exports.renderProgress = renderProgress;
/**
 * Calculates the number of filled progress bar segments for a percentage.
 * @param percent - The percentage value.
 * @param total - The total number of segments.
 * @returns {number} The number of filled segments.
 */
function getFilledCount(percent, total) {
    const clamped = Math.max(0, Math.min(100, percent));
    return Math.round((clamped / 100) * total);
}
/**
 * Renders a textual progress bar for the given percentage.
 * @param percent - The percentage value.
 * @param total - The total number of bar segments (defaults to 10).
 * @returns {string} The rendered progress bar string.
 */
function renderProgress(percent, total = 10) {
    const filled = getFilledCount(percent, total), full = '\u2588', empty = '\u2591', bar = full.repeat(filled) + empty.repeat(total - filled);
    const clamped = Math.max(0, Math.min(100, percent));
    return `${bar} ${clamped}%`;
}
