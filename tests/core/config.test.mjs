import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_DATA_DIR,
  addDays,
  daysBetween,
  ensureDataDir,
  formatLocalDate,
  formatLocalMonth,
  isValidDateString,
  isValidMonthString,
  listDaysInMonth,
  resolveDataDir,
  todayLocal,
} from '../../core/config.mjs';
import { tempDir } from './helpers.mjs';

test('空值与未展开占位符回退默认目录', () => {
  assert.equal(resolveDataDir({}), DEFAULT_DATA_DIR);
  assert.equal(resolveDataDir({ DAILY_NOTES_DATA_DIR: '   ' }), DEFAULT_DATA_DIR);
  assert.equal(resolveDataDir({ DAILY_NOTES_DATA_DIR: '${env:DAILY_NOTES_DATA_DIR}' }), DEFAULT_DATA_DIR);
  assert.equal(resolveDataDir({ DAILY_NOTES_DATA_DIR: ' ${env:OTHER} ' }), DEFAULT_DATA_DIR);
  assert.equal(DEFAULT_DATA_DIR, path.join(homedir(), '.gemini', 'daily-notes'));
});

test('显式目录被解析为绝对路径并展开 ~', () => {
  assert.equal(resolveDataDir({ DAILY_NOTES_DATA_DIR: '/tmp/dn' }), '/tmp/dn');
  assert.equal(resolveDataDir({ DAILY_NOTES_DATA_DIR: '~/dn-data' }), path.join(homedir(), 'dn-data'));
  assert.equal(resolveDataDir({ DAILY_NOTES_DATA_DIR: 'relative/dn' }), path.resolve('relative/dn'));
});

test('ensureDataDir 递归创建目录', (t) => {
  const base = tempDir(t);
  const nested = path.join(base, 'a', 'b', 'c');
  const dir = ensureDataDir({ DAILY_NOTES_DATA_DIR: nested });

  assert.equal(dir, nested);
  assert.ok(existsSync(nested));
  assert.ok(statSync(nested).isDirectory());
});

test('严格日历校验拒绝不存在的日期', () => {
  assert.equal(isValidDateString('2026-11-25'), true);
  assert.equal(isValidDateString('2024-02-29'), true);
  assert.equal(isValidDateString('2026-02-29'), false);
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('2026-00-10'), false);
  assert.equal(isValidDateString('2026-1-1'), false);
  assert.equal(isValidDateString('　2026-11-25'), false);
  assert.equal(isValidDateString(null), false);
  assert.equal(isValidDateString(20261125), false);
});

test('月份校验', () => {
  assert.equal(isValidMonthString('2026-11'), true);
  assert.equal(isValidMonthString('2026-13'), false);
  assert.equal(isValidMonthString('2026-1'), false);
});

test('本地日期格式化使用本机时区', () => {
  const sample = new Date(2026, 10, 5, 23, 30);
  assert.equal(formatLocalDate(sample), '2026-11-05');
  assert.equal(formatLocalMonth(sample), '2026-11');
  assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(isValidDateString(todayLocal()), true);
});

test('addDays / daysBetween 跨月跨年', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(daysBetween('2026-11-01', '2026-11-25'), 24);
  assert.throws(() => addDays('2026-02-30', 1), /非法日期/);
});

test('listDaysInMonth 返回完整自然日序列', () => {
  assert.equal(listDaysInMonth('2026-11').length, 30);
  assert.equal(listDaysInMonth('2024-02').length, 29);
  assert.equal(listDaysInMonth('2026-02').length, 28);
  assert.deepEqual(listDaysInMonth('2026-11').slice(0, 3), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.throws(() => listDaysInMonth('2026-13'), /非法月份/);
});
