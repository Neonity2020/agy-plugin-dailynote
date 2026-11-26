import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  daysBetween,
  getLocalDateString,
  isValidDateString,
  isValidMonthString,
  monthDateBounds,
  resolveDataDir,
  shiftDateString,
} from '../../core/config.mjs';

test('resolveDataDir handles default, env, unexpanded placeholder, ~ expansion, and override', () => {
  const prev = process.env.DAILY_NOTES_DATA_DIR;
  try {
    delete process.env.DAILY_NOTES_DATA_DIR;
    assert.equal(resolveDataDir(), path.join(os.homedir(), '.gemini', 'daily-notes'));

    process.env.DAILY_NOTES_DATA_DIR = '${env:DAILY_NOTES_DATA_DIR}';
    assert.equal(resolveDataDir(), path.join(os.homedir(), '.gemini', 'daily-notes'));

    process.env.DAILY_NOTES_DATA_DIR = '   ';
    assert.equal(resolveDataDir(), path.join(os.homedir(), '.gemini', 'daily-notes'));

    process.env.DAILY_NOTES_DATA_DIR = '~/custom-notes';
    assert.equal(resolveDataDir(), path.join(os.homedir(), 'custom-notes'));

    assert.equal(resolveDataDir('/tmp/explicit-dn'), path.resolve('/tmp/explicit-dn'));
  } finally {
    if (prev === undefined) delete process.env.DAILY_NOTES_DATA_DIR;
    else process.env.DAILY_NOTES_DATA_DIR = prev;
  }
});

test('isValidDateString rejects impossible calendar dates and accepts leap day', () => {
  assert.equal(isValidDateString('2026-11-25'), true);
  assert.equal(isValidDateString('2024-02-29'), true);
  assert.equal(isValidDateString('2025-02-29'), false);
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('2026-1-5'), false);
  assert.equal(isValidDateString('not-a-date'), false);
});

test('date helpers shiftDateString, daysBetween, monthDateBounds, and getLocalDateString work accurately', () => {
  assert.equal(shiftDateString('2026-02-28', 1), '2026-03-01');
  assert.equal(shiftDateString('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDateString('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-11-20', '2026-11-25'), 5);
  assert.equal(daysBetween('2026-11-25', '2026-11-20'), -5);

  assert.equal(isValidMonthString('2026-11'), true);
  assert.equal(isValidMonthString('2026-13'), false);
  assert.deepEqual(monthDateBounds('2024-02'), { startDate: '2024-02-01', endDate: '2024-02-29' });
  assert.deepEqual(monthDateBounds('2026-02'), { startDate: '2026-02-01', endDate: '2026-02-28' });

  const localStr = getLocalDateString(new Date(2026, 10, 25, 23, 55, 0));
  assert.equal(localStr, '2026-11-25');
});
