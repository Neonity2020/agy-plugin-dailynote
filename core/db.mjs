import fs from 'node:fs';
import path from 'node:path';
import { nowIso, resolveDataDir } from './config.mjs';
import { StorageAdapter } from './storage-adapter.mjs';

export const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS note_tags (
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_date, tag)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_date ON note_tags(tag, note_date DESC);

CREATE TABLE IF NOT EXISTS note_projects (
  note_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  workspace_uri TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  linked_by TEXT NOT NULL DEFAULT 'user' CHECK (linked_by IN ('user', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_date, workspace_uri)
);

CREATE INDEX IF NOT EXISTS idx_note_projects_ws_date ON note_projects(workspace_uri, note_date DESC);

CREATE TABLE IF NOT EXISTS note_links (
  source_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  target_date TEXT NOT NULL CHECK (target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (source_date, target_date)
);

CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_date, source_date DESC);

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

CREATE TABLE IF NOT EXISTS todo_carryovers (
  target_date TEXT NOT NULL REFERENCES notes(date) ON DELETE CASCADE,
  source_date TEXT NOT NULL CHECK (source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  item_hash TEXT NOT NULL,
  carried_at TEXT NOT NULL,
  PRIMARY KEY (target_date, source_date, item_hash)
);
`;

export function runMigrations(adapter) {
  adapter.transaction(() => {
    adapter.exec(SCHEMA_V1_SQL);
    const existing = adapter.get(
      'SELECT version FROM schema_migrations WHERE version = ?',
      CURRENT_SCHEMA_VERSION,
    );
    if (!existing) {
      adapter.run(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        CURRENT_SCHEMA_VERSION,
        nowIso(),
      );
    }
  });
}

/**
 * Open and initialize the Daily Notes SQLite database and local storage directories.
 */
export function openDatabase(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const attachmentsDir = path.join(dataDir, 'attachments');
  const dbPath = path.join(dataDir, 'notes.db');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const adapter = new StorageAdapter(dbPath);
  try {
    runMigrations(adapter);
  } catch (err) {
    adapter.close();
    throw err;
  }

  return {
    dataDir,
    dbPath,
    attachmentsDir,
    adapter,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    close() {
      adapter.close();
    },
  };
}
