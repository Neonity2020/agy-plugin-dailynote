import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase, applyMigrations, currentSchemaVersion, SCHEMA_VERSION } from '../../core/db.mjs';
import { assertNodeVersion, isNodeVersionSupported, MIN_NODE_VERSION } from '../../core/storage-adapter.mjs';
import { tempDir } from './helpers.mjs';

test('Node 版本门槛按 22.5.0 比较', () => {
  assert.equal(MIN_NODE_VERSION, '22.5.0');
  assert.equal(isNodeVersionSupported('22.4.9'), false);
  assert.equal(isNodeVersionSupported('22.5.0'), true);
  assert.equal(isNodeVersionSupported('23.0.0'), true);
  assert.equal(isNodeVersionSupported('22.5.1'), true);
  assert.throws(() => assertNodeVersion('20.11.1'), /需要 Node\.js/);
  assert.doesNotThrow(() => assertNodeVersion());
});

test('连接依次应用全部 5 条 PRAGMA', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  const pragmas = adapter.readPragmas();
  assert.equal(pragmas.journal_mode, 'wal');
  assert.equal(Number(pragmas.synchronous), 1); // NORMAL
  assert.equal(Number(pragmas.foreign_keys), 1);
  assert.equal(Number(pragmas.busy_timeout), 5000);
  assert.equal(Number(pragmas.temp_store), 2); // MEMORY

  adapter.close();
});

test('schema_migrations 记录到 v1 且迁移幂等', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  assert.equal(currentSchemaVersion(adapter), SCHEMA_VERSION);
  const row = adapter.get('SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1');
  assert.equal(row.version, 1);
  assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T/);

  const again = applyMigrations(adapter);
  assert.deepEqual(again.applied, []);
  assert.equal(
    adapter.get('SELECT COUNT(*) AS count FROM schema_migrations').count,
    1,
  );

  adapter.close();
});

test('DATA_MODEL 规定的表与触发器全部存在', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  const tables = adapter
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
  for (const name of [
    'schema_migrations',
    'notes',
    'notes_fts',
    'note_tags',
    'note_projects',
    'note_links',
    'note_revisions',
    'attachments',
    'todo_carryovers',
  ]) {
    assert.ok(tables.includes(name), `缺少表 ${name}`);
  }

  const triggers = adapter
    .all("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .map((row) => row.name);
  assert.deepEqual(triggers, ['notes_ad', 'notes_ai', 'notes_au']);

  const ftsSql = adapter.get("SELECT sql FROM sqlite_master WHERE name = 'notes_fts'").sql;
  assert.match(ftsSql, /trigram/);

  adapter.close();
});

test('FTS 触发器在插入/更新/删除时同步索引', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  const insert = () => {
    adapter.run(
      `INSERT INTO notes (date, content_md, plain_text, created_at, updated_at)
       VALUES ('2026-11-25', '每日笔记 SQLite 调试', '每日笔记 SQLite 调试', 'x', 'x')`,
    );
  };
  const ftsCount = () => adapter.get('SELECT COUNT(*) AS count FROM notes_fts').count;

  insert();
  assert.equal(ftsCount(), 1);
  assert.equal(adapter.all("SELECT date FROM notes_fts WHERE notes_fts MATCH '\"每日笔记\"'").length, 1);

  adapter.run("UPDATE notes SET content_md = '完全不同的内容 ABC', plain_text = '' WHERE date = '2026-11-25'");
  assert.equal(adapter.all("SELECT date FROM notes_fts WHERE notes_fts MATCH '\"每日笔记\"'").length, 0);
  assert.equal(adapter.all("SELECT date FROM notes_fts WHERE notes_fts MATCH '\"ABC\"'").length, 1);

  adapter.run("DELETE FROM notes WHERE date = '2026-11-25'");
  assert.equal(ftsCount(), 0);

  adapter.close();
});

test('notes.date 的 GLOB 约束与编辑器枚举生效', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  adapter.run("INSERT INTO notes (date, created_at, updated_at) VALUES ('2026-11-25', 'x', 'x')");
  assert.throws(
    () => adapter.run("INSERT INTO notes (date, created_at, updated_at) VALUES ('26-11-25', 'x', 'x')"),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      adapter.run(
        "INSERT INTO notes (date, last_editor, created_at, updated_at) VALUES ('2026-11-26', 'robot', 'x', 'x')",
      ),
    /CHECK constraint failed/,
  );

  adapter.close();
});

test('外键级联删除清理从属表', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  adapter.run("INSERT INTO notes (date, content_md, created_at, updated_at) VALUES ('2026-11-25', 'x', 'x', 'x')");
  adapter.run("INSERT INTO note_tags (note_date, tag) VALUES ('2026-11-25', 'perf')");
  adapter.run("INSERT INTO note_links (source_date, target_date) VALUES ('2026-11-25', '2026-11-24')");

  adapter.run("DELETE FROM notes WHERE date = '2026-11-25'");
  assert.equal(adapter.get('SELECT COUNT(*) AS count FROM note_tags').count, 0);
  assert.equal(adapter.get('SELECT COUNT(*) AS count FROM note_links').count, 0);

  adapter.close();
});
