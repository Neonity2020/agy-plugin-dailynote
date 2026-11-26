import os from 'node:os';
import path from 'node:path';

const UNEXPANDED_PLACEHOLDER_RE = /^\$\{[^}]+\}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Expand a leading ~ to the current user's home directory.
 */
export function expandHomeDir(inputPath) {
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Resolve the local persistence directory for Daily Notes.
 * Priority: explicit overrideDir -> DAILY_NOTES_DATA_DIR env -> ~/.gemini/daily-notes
 */
export function resolveDataDir(overrideDir) {
  const candidates = [overrideDir, process.env.DAILY_NOTES_DATA_DIR];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || UNEXPANDED_PLACEHOLDER_RE.test(trimmed)) continue;
    return path.resolve(expandHomeDir(trimmed));
  }
  return path.resolve(path.join(os.homedir(), '.gemini', 'daily-notes'));
}

/**
 * Format a Date instance into local natural-day YYYY-MM-DD.
 */
export function getLocalDateString(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Validate a YYYY-MM-DD string as a real Gregorian calendar date.
 */
export function isValidDateString(str) {
  if (typeof str !== 'string') return false;
  const match = DATE_RE.exec(str);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Validate a YYYY-MM month string.
 */
export function isValidMonthString(str) {
  return typeof str === 'string' && MONTH_RE.test(str);
}

/**
 * Shift a valid YYYY-MM-DD date string by deltaDays.
 */
export function shiftDateString(dateStr, deltaDays) {
  if (!isValidDateString(dateStr)) {
    throw new Error(`Invalid date string: ${dateStr}`);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Return signed integer day difference (endStr - startStr).
 */
export function daysBetween(startStr, endStr) {
  if (!isValidDateString(startStr) || !isValidDateString(endStr)) {
    throw new Error(`Invalid date range: ${startStr} .. ${endStr}`);
  }
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  return Math.round((endUtc - startUtc) / 86_400_000);
}

/**
 * Return { startDate, endDate } bounds for a YYYY-MM month string.
 */
export function monthDateBounds(monthStr) {
  if (!isValidMonthString(monthStr)) {
    throw new Error(`Invalid month string: ${monthStr}`);
  }
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    startDate: `${monthStr}-01`,
    endDate: `${monthStr}-${String(lastDay).padStart(2, '0')}`,
  };
}

/**
 * Return current ISO 8601 timestamp string.
 */
export function nowIso() {
  return new Date().toISOString();
}
