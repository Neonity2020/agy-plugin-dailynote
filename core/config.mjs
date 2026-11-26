/**
 * 运行环境与数据目录配置。
 *
 * 规则来源：docs/DATA_MODEL.md 第 1 节、docs/ARCHITECTURE.md 第 2.3 节。
 * - 默认数据目录为 ~/.gemini/daily-notes
 * - DAILY_NOTES_DATA_DIR 为空、全空白或仍是未展开的 ${...} 占位符时一律视为未设置
 * - 日期一律使用本机时区自然日，并做严格日历合法性校验
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_DATA_DIR = path.join(homedir(), '.gemini', 'daily-notes');
export const DATA_DIR_ENV = 'DAILY_NOTES_DATA_DIR';
export const DB_FILENAME = 'notes.db';
export const ATTACHMENTS_DIRNAME = 'attachments';

const PLACEHOLDER_RE = /\$\{[^}]*\}/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

/**
 * 解析数据目录，不做磁盘写入。
 * 未设置 / 空白 / 占位符 → 回退默认目录；相对路径按进程 cwd 解析为绝对路径。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} 绝对路径
 */
export function resolveDataDir(env = process.env) {
  const raw = env?.[DATA_DIR_ENV];
  if (typeof raw !== 'string') return DEFAULT_DATA_DIR;

  const trimmed = raw.trim();
  if (trimmed === '' || PLACEHOLDER_RE.test(trimmed)) return DEFAULT_DATA_DIR;

  return path.resolve(expandHome(trimmed));
}

/**
 * 解析数据目录并确保它存在（递归创建）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} 绝对路径
 */
export function ensureDataDir(env = process.env) {
  const dir = resolveDataDir(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function dbPathFor(dataDir) {
  return path.join(dataDir, DB_FILENAME);
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function attachmentsDirFor(dataDir) {
  return path.join(dataDir, ATTACHMENTS_DIRNAME);
}

/**
 * 严格校验 YYYY-MM-DD 且是真实存在的日历日期。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidMonthString(value) {
  if (typeof value !== 'string') return false;
  const match = MONTH_RE.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 按本机时区格式化自然日。
 *
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD
 */
export function formatLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 本机时区的今天。
 *
 * @returns {string}
 */
export function todayLocal() {
  return formatLocalDate(new Date());
}

/**
 * 按月本地时区格式化。
 *
 * @param {Date} [date]
 * @returns {string} YYYY-MM
 */
export function formatLocalMonth(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/**
 * 纯日历天数偏移（UTC 锚点，避免夏令时偏差）。
 *
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
export function addDays(dateStr, days) {
  assertDate(dateStr);
  const [year, month, day] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * 两个日期之间的自然日跨度（含首尾为 1，同日为 0）。
 *
 * @param {string} startDate
 * @param {string} endDate
 * @returns {number}
 */
export function daysBetween(startDate, endDate) {
  assertDate(startDate);
  assertDate(endDate);
  const toMs = (value) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round(Math.abs(toMs(endDate) - toMs(startDate)) / 86_400_000);
}

/**
 * 返回某月的全部自然日。
 *
 * @param {string} month YYYY-MM
 * @returns {string[]}
 */
export function listDaysInMonth(month) {
  if (!isValidMonthString(month)) {
    throw new RangeError(`非法月份：${month}`);
  }
  const [year, monthPart] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthPart, 0)).getUTCDate();
  const dates = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    dates.push(`${year}-${pad2(monthPart)}-${pad2(day)}`);
  }
  return dates;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertDate(value) {
  if (!isValidDateString(value)) {
    throw new RangeError(`非法日期（期望合法 YYYY-MM-DD）：${String(value)}`);
  }
  return /** @type {string} */ (value);
}

/**
 * 恢复为存储时间戳（ISO 8601）。
 *
 * @param {Date | number | string} [input]
 * @returns {string}
 */
export function toTimestamp(input = new Date()) {
  if (input instanceof Date) return input.toISOString();
  if (typeof input === 'number') return new Date(input).toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`非法时间戳：${String(input)}`);
  return parsed.toISOString();
}
