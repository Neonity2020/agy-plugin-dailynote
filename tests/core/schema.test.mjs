import assert from 'node:assert/strict';
import test from 'node:test';
import { CURRENT_SCHEMA_VERSION, openDatabase } from '../../core/db.mjs';
import { createTempDataDir } from './helpers.mjs';

test('openDatabase configures WAL PRAGMAs, creates schema v1 tables, and is idempotent', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    assert.equal(dbCtx.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(String(dbCtx.adapter.getPragma('journal_mode')).toLowerCase(), 'wal');
    assert.equal(Number(dbCtx.adapter.getPragma('foreign_keys')), 1);
    assert.equal(Number(dbCtx.adapter.getPragma('busy_timeout')), 5000);

    const tables = dbCtx.adapter
      .all("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .map((r) => r.name);

    for (const expected of [
      'attachments',
      'note_links',
      'note_projects',
      'note_revisions',
      'note_tags',
      'notes',
      'notes_fts',
      'schema_migrations',
      'todo_carryovers',
    ]) {
      assert.ok(tables.includes(expected), `Missing table: ${expected}`);
    }

    const migrationRow = dbCtx.adapter.get('SELECT version FROM schema_migrations WHERE version = 1');
    assert.equal(migrationRow.version, 1);

    // Re-open idempotently
    dbCtx.close();
    const reopened = openDatabase({ dataDir: tmp.dir });
    const countRow = reopened.adapter.get('SELECT COUNT(*) AS c FROM schema_migrations');
    assert.equal(countRow.c, 1);
    reopened.close();
  } finally {
    tmp.cleanup();
  }
});

test('FTS5 trigram triggers sync insert, update, and delete automatically', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    const now = new Date().toISOString();

    dbCtx.adapter.run(
      `INSERT INTO notes (date, title, content_md, plain_text, word_count, todo_total, todo_done, revision, last_editor, created_at, updated_at)
       VALUES (?, ?, ?, ?, 10, 0, 0, 1, 'user', ?, ?)`,
      '2026-11-25',
      '每日笔记测试',
      '# 每日笔记测试\n调试 SQLite trigram 索引',
      '每日笔记测试\n调试 SQLite trigram 索引',
      now,
      now,
    );

    const hit1 = dbCtx.adapter.all(
      "SELECT date FROM notes_fts WHERE notes_fts MATCH '\"每日笔记\"'",
    );
    assert.deepEqual(hit1.map((r) => r.date), ['2026-11-25']);

    dbCtx.adapter.run(
      'UPDATE notes SET content_md = ?, plain_text = ? WHERE date = ?',
      '已经替换为全新内容',
      '已经替换为全新内容',
      '2026-11-25',
    );

    const oldHit = dbCtx.adapter.all(
      "SELECT date FROM notes_fts WHERE notes_fts MATCH '\"每日笔记\"'",
    );
    assert.equal(oldHit.length, 0);

    const newHit = dbCtx.adapter.all(
      "SELECT date FROM notes_fts WHERE notes_fts MATCH '\"全新内容\"'",
    );
    assert.deepEqual(newHit.map((r) => r.date), ['2026-11-25']);

    dbCtx.adapter.run('DELETE FROM notes WHERE date = ?', '2026-11-25');
    const afterDel = dbCtx.adapter.all(
      "SELECT date FROM notes_fts WHERE notes_fts MATCH '\"全新内容\"'",
    );
    assert.equal(afterDel.length, 0);

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});
