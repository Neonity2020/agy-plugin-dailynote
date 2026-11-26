/**
 * Schema 迁移与数据库打开入口。
 *
 * DDL 逐字对齐 docs/DATA_MODEL.md 第 3 节（v1）。迁移过程本身也在写事务中执行，
 * 保证多进程首次打开时不会留下半张表。
 */

import { mkdirSync } from 'node:fs';

import { ensureDataDir, dbPathFor } from './config.mjs';
import { createAdapter } from './storage-adapter.mjs';

export const SCHEMA_VERSION = 1;

const V1_DDL = `
-- 1. Schema 版本迁移记录
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 2. 每日笔记主表（按本地自然日唯一）
CREATE TABLE IF NOT EXISTS notes (
  date TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  title TEXT NOT NULL DEFAULT '',
  content_md TEXT NOT NULL DEFAULT '',
  plain_text TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  todo_total INTEGER NOT NULL DEFAULT 0,
  todo_done INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  last_editor TEXT NOT NULL DEFAULT 'user' CHECK (last_editor IN ('user', 'agent', 'system')),
  carry_over_from TEXT CHECK (carry_over_from IS NULL OR carry_over_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  carry_over_dismissed INTEGER NOT NULL DEFAULT 0 CHECK (carry_over_dismissed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_agent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);

-- 3. 中文 + 英文全文检索虚拟表（FTS5 trigram + 触发器自动同步）
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  date UNINDEXED,
  content_md,
  plain_text,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, date, content_md, plain_text)
  VALUES (new.rowid, new.date, new.content_md, new.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, date, content_md, plain_text)
  VALUES ('delete', old.rowid, old.date, old.content_md, old.plain_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF content_md, plain_text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, date, content_md, plain_text)
  VALUES ('delete', old.rowid, old.date, old.content_md, old.plain_text);
  INSERT INTO notes_fts(rowid, date, content_md, plain_text)
  VALUES (new.rowid, new.date, new.content_md, new.plain_text);
END;

-- 4. 正文 #标签 索引表
CREATE TABLE IF NOT EXISTS note_tags (
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_date, tag)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_date ON note_tags(tag, note_date DESC);

-- 5. 可选工作区项目关联表
CREATE TABLE IF NOT EXISTS note_projects (
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  workspace_uri TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  linked_by TEXT NOT NULL DEFAULT 'user' CHECK (linked_by IN ('user', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_date, workspace_uri)
);

CREATE INDEX IF NOT EXISTS idx_note_projects_ws_date ON note_projects(workspace_uri, note_date DESC);

-- 6. 日期双链 [[YYYY-MM-DD]] 索引表
CREATE TABLE IF NOT EXISTS note_links (
  source_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  target_date TEXT NOT NULL CHECK (target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (source_date, target_date)
);

CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_date, source_date DESC);

-- 7. 历史快照表（AI 写入前 / 回滚前自动备份）
CREATE TABLE IF NOT EXISTS note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'restore_backup', 'manual_checkpoint', 'carry_over_backup')),
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_revisions_date_rev ON note_revisions(note_date, revision DESC, id DESC);

-- 8. 本地图片附件元信息表
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  note_date TEXT REFERENCES notes(date) ON DELETE SET NULL,
  rel_path TEXT NOT NULL UNIQUE,
  orig_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  orphaned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_note_date ON attachments(note_date);
CREATE INDEX IF NOT EXISTS idx_attachments_orphaned_at ON attachments(orphaned_at);

-- 9. 昨日待办顺延幂等去重表
CREATE TABLE IF NOT EXISTS todo_carryovers (
  target_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  source_date TEXT NOT NULL CHECK (source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  item_hash TEXT NOT NULL,
  carried_at TEXT NOT NULL,
  PRIMARY KEY (target_date, source_date, item_hash)
);
`;

/**
 * @typedef {{ version: number, ddl: string }} Migration
 * @type {readonly Migration[]}
 */
export const MIGRATIONS = Object.freeze([{ version: 1, ddl: V1_DDL }]);

/**
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @returns {{ from: number, to: number }}
 */
export function currentSchemaVersion(adapter) {
  const table = adapter.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (!table) return 0;
  const row = adapter.get('SELECT MAX(version) AS version FROM schema_migrations');
  return Number(row?.version ?? 0);
}

/**
 * 幂等地把库升级到最新版本。
 *
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @param {{ now?: () => Date }} [options]
 * @returns {{ from: number, to: number, applied: number[] }}
 */
export function applyMigrations(adapter, options = {}) {
  const now = options.now ?? (() => new Date());
  const from = currentSchemaVersion(adapter);
  const applied = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;

    adapter.transaction(() => {
      const ftsExists = adapter.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
      );
      adapter.exec(migration.ddl);
      if (!ftsExists) {
        // 外部内容 FTS：首次建表后重建一次，防止对已有 notes 行漏索引
        adapter.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
      }
      adapter.run('INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        migration.version,
        now().toISOString(),
      ]);
    });

    applied.push(migration.version);
  }

  return { from, to: currentSchemaVersion(adapter), applied };
}

/**
 * 打开（必要时创建）数据库并保证 schema 已迁移到最新版本。
 *
 * @param {{ dataDir?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ adapter: import('./storage-adapter.mjs').StorageAdapter, dataDir: string, dbPath: string }>}
 */
export async function openDatabase(options = {}) {
  const dataDir = options.dataDir ?? ensureDataDir(options.env ?? process.env);
  mkdirSync(dataDir, { recursive: true });
  const dbPath = dbPathFor(dataDir);
  const adapter = await createAdapter(dbPath);

  try {
    applyMigrations(adapter);
  } catch (error) {
    adapter.close();
    throw error;
  }

  return { adapter, dataDir, dbPath };
}
