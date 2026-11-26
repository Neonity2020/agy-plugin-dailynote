/* Bundled zero-dependency Sidecar runtime for Daily Notes (@daily-notes/core inlined) */

// sidecars/daily_notes/src/main.mjs
import fs3 from "node:fs";
import http from "node:http";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// ../core/src/config.mjs
import os from "node:os";
import path from "node:path";
var UNEXPANDED_PLACEHOLDER_RE = /^\$\{[^}]+\}$/;
var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
var MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
function expandHomeDir(inputPath) {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
function resolveDataDir(overrideDir) {
  const candidates = [overrideDir, process.env.DAILY_NOTES_DATA_DIR];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || UNEXPANDED_PLACEHOLDER_RE.test(trimmed)) continue;
    return path.resolve(expandHomeDir(trimmed));
  }
  return path.resolve(path.join(os.homedir(), ".gemini", "daily-notes"));
}
function getLocalDateString(date = /* @__PURE__ */ new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function isValidDateString(str) {
  if (typeof str !== "string") return false;
  const match = DATE_RE.exec(str);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}
function isValidMonthString(str) {
  return typeof str === "string" && MONTH_RE.test(str);
}
function shiftDateString(dateStr, deltaDays) {
  if (!isValidDateString(dateStr)) {
    throw new Error(`Invalid date string: ${dateStr}`);
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const year = String(dt.getUTCFullYear()).padStart(4, "0");
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function daysBetween(startStr, endStr) {
  if (!isValidDateString(startStr) || !isValidDateString(endStr)) {
    throw new Error(`Invalid date range: ${startStr} .. ${endStr}`);
  }
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  return Math.round((endUtc - startUtc) / 864e5);
}
function monthDateBounds(monthStr) {
  if (!isValidMonthString(monthStr)) {
    throw new Error(`Invalid month string: ${monthStr}`);
  }
  const [y, m] = monthStr.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    startDate: `${monthStr}-01`,
    endDate: `${monthStr}-${String(lastDay).padStart(2, "0")}`
  };
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// ../core/src/storage-adapter.mjs
import { DatabaseSync } from "node:sqlite";
var SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}
function isBusyError(err) {
  if (!err) return false;
  const code = String(err.errcode ?? err.code ?? "");
  const msg = String(err.message ?? "").toLowerCase();
  return code === "5" || code === "SQLITE_BUSY" || msg.includes("database is locked") || msg.includes("busy");
}
var StorageAdapter = class {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this._closed = false;
    this._txDepth = 0;
    this._savepointSeq = 0;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA temp_store = MEMORY;");
  }
  isOpen() {
    return !this._closed;
  }
  getPragma(name) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid PRAGMA name: ${name}`);
    }
    const row = this.db.prepare(`PRAGMA ${name};`).get();
    if (!row) return void 0;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : void 0;
  }
  exec(sql) {
    return this.db.exec(sql);
  }
  prepare(sql) {
    return this.db.prepare(sql);
  }
  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }
  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }
  /**
   * Execute fn inside a BEGIN IMMEDIATE transaction (with nested SAVEPOINT support).
   */
  transaction(fn) {
    if (this._txDepth > 0) {
      const spName = `sp_${++this._savepointSeq}`;
      this.db.exec(`SAVEPOINT ${spName};`);
      this._txDepth += 1;
      try {
        const result = fn(this);
        this.db.exec(`RELEASE SAVEPOINT ${spName};`);
        return result;
      } catch (err) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
          this.db.exec(`RELEASE SAVEPOINT ${spName};`);
        } catch {
        }
        throw err;
      } finally {
        this._txDepth -= 1;
      }
    }
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE;");
        break;
      } catch (err) {
        if (isBusyError(err) && attempt < maxAttempts - 1) {
          sleepSync(10 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    this._txDepth = 1;
    try {
      const result = fn(this);
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
      }
      throw err;
    } finally {
      this._txDepth = 0;
    }
  }
  close() {
    if (!this._closed) {
      this.db.close();
      this._closed = true;
    }
  }
};

// ../core/src/db.mjs
import fs from "node:fs";
import path2 from "node:path";
var CURRENT_SCHEMA_VERSION = 1;
var SCHEMA_V1_SQL = `
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
function runMigrations(adapter) {
  adapter.transaction(() => {
    adapter.exec(SCHEMA_V1_SQL);
    const existing = adapter.get(
      "SELECT version FROM schema_migrations WHERE version = ?",
      CURRENT_SCHEMA_VERSION
    );
    if (!existing) {
      adapter.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        CURRENT_SCHEMA_VERSION,
        nowIso()
      );
    }
  });
}
function openDatabase(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const attachmentsDir = path2.join(dataDir, "attachments");
  const dbPath = path2.join(dataDir, "notes.db");
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
    }
  };
}

// ../core/src/markdown.mjs
import crypto from "node:crypto";
var FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
var ATX_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
var TASK_LINE_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])(?:\s+(.*))?$/;
var TAG_RE = /(?:^|[\s(（【\[])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,48})/gu;
var WIKILINK_RE = /\[\[(\d{4}-\d{2}-\d{2})\]\]/g;
var ATTACHMENT_URL_RE = /\/api\/attachments?\/([a-zA-Z0-9_-]{12,64})|\/api\/attachment\?id=([a-zA-Z0-9_-]{12,64})/g;
var CJK_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
var LATIN_WORD_RE = /[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g;
function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}
function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function normalizeTodoText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function isClosingFence(line, fenceChar, fenceLen) {
  const escaped = fenceChar === "`" ? "`" : "~";
  const re = new RegExp(`^\\s{0,3}${escaped}{${fenceLen},}\\s*$`);
  return re.test(line);
}
function parseLinesWithFences(contentMd) {
  const normalized = normalizeLineEndings(contentMd);
  const rawLines = normalized.split("\n");
  let activeFence = null;
  return rawLines.map((line, index) => {
    const lineNumber = index + 1;
    if (activeFence) {
      if (isClosingFence(line, activeFence.char, activeFence.len)) {
        activeFence = null;
        return { lineNumber, line, inFence: true, isFenceBoundary: true };
      }
      return { lineNumber, line, inFence: true, isFenceBoundary: false };
    }
    const openMatch = FENCE_OPEN_RE.exec(line);
    if (openMatch) {
      const marker = openMatch[1];
      if (!(marker[0] === "`" && openMatch[2].includes("`"))) {
        activeFence = { char: marker[0], len: marker.length };
        return { lineNumber, line, inFence: true, isFenceBoundary: true };
      }
    }
    return { lineNumber, line, inFence: false, isFenceBoundary: false };
  });
}
function stripInlineCode(text) {
  return text.replace(/(`+)([\s\S]*?)\1/g, " ");
}
function stripMarkdownUrls(text) {
  return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<https?:\/\/[^>]+>/gi, " ").replace(/https?:\/\/[^\s)>\]]+/gi, " ");
}
function stripMarkdownSyntaxForPlainText(linesWithFences) {
  const out = [];
  for (const entry of linesWithFences) {
    if (entry.isFenceBoundary) continue;
    let text = entry.line;
    if (!entry.inFence) {
      text = text.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s*/, "").replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/^\s*>\s?/, "").replace(/^\s{0,3}(?:[-*_]\s*){3,}$/, "").replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/, "");
      text = stripMarkdownUrls(text);
      text = text.replace(/\|/g, " ").replace(/(`+)([^`]*)\1/g, "$2").replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/~~(.*?)~~/g, "$1").replace(/==(.*?)==/g, "$1").replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1").replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1").replace(/\[\[(\d{4}-\d{2}-\d{2})\]\]/g, "$1");
    }
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (collapsed) out.push(collapsed);
  }
  return out.join("\n");
}
function countWords(plainText) {
  if (!plainText) return 0;
  const cjkMatches = plainText.match(CJK_CHAR_RE) || [];
  const withoutCjk = plainText.replace(CJK_CHAR_RE, " ");
  const latinMatches = withoutCjk.match(LATIN_WORD_RE) || [];
  return cjkMatches.length + latinMatches.length;
}
function extractMetadata(contentMd) {
  const normalized = normalizeLineEndings(contentMd);
  const lines = parseLinesWithFences(normalized);
  let title = "";
  const todos = [];
  const tagSet = /* @__PURE__ */ new Set();
  const linkSet = /* @__PURE__ */ new Set();
  for (const entry of lines) {
    if (entry.inFence) continue;
    if (!title) {
      const hMatch = ATX_HEADING_RE.exec(entry.line);
      if (hMatch) {
        title = hMatch[2].trim();
      }
    }
    const tMatch = TASK_LINE_RE.exec(entry.line);
    if (tMatch) {
      const completed = tMatch[2].toLowerCase() === "x";
      const rawText = (tMatch[4] ?? "").trim();
      if (rawText.length > 0) {
        const normText = normalizeTodoText(rawText);
        todos.push({
          lineNumber: entry.lineNumber,
          completed,
          text: rawText,
          normalizedText: normText,
          hash: sha256Hex(normText)
        });
      }
    }
    const withoutCode = stripInlineCode(entry.line);
    for (const match of withoutCode.matchAll(WIKILINK_RE)) {
      const dateStr = match[1];
      if (isValidDateString(dateStr)) {
        linkSet.add(dateStr);
      }
    }
    const lineForTags = stripMarkdownUrls(withoutCode).replace(/^\s{0,3}#{1,6}\s+/, "");
    for (const match of lineForTags.matchAll(TAG_RE)) {
      const cleanTag = match[1].replace(/[-/]+$/, "").toLowerCase();
      if (cleanTag) {
        tagSet.add(cleanTag);
      }
    }
  }
  const plain_text = stripMarkdownSyntaxForPlainText(lines);
  if (!title && plain_text) {
    const firstLine = plain_text.split("\n")[0].trim();
    title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}\u2026` : firstLine;
  }
  const attachmentSet = /* @__PURE__ */ new Set();
  for (const match of normalized.matchAll(ATTACHMENT_URL_RE)) {
    const id = match[1] || match[2];
    if (id) attachmentSet.add(id);
  }
  const todo_total = todos.length;
  const todo_done = todos.filter((t) => t.completed).length;
  return {
    title,
    plain_text,
    word_count: countWords(plain_text),
    todo_total,
    todo_done,
    todos,
    tags: [...tagSet],
    links: [...linkSet],
    attachment_ids: [...attachmentSet]
  };
}
function normalizeHeadingText(raw) {
  return String(raw ?? "").trim().replace(/^#{1,6}\s+/, "").replace(/\s+#*\s*$/, "").trim();
}
function findHeadingSectionRange(lines, targetHeading) {
  const target = normalizeHeadingText(targetHeading).toLowerCase();
  if (!target) return null;
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (entry.inFence) continue;
    const hMatch = ATX_HEADING_RE.exec(entry.line);
    if (!hMatch) continue;
    const level = hMatch[1].length;
    const headingTitle = normalizeHeadingText(hMatch[2]).toLowerCase();
    if (headingTitle !== target) continue;
    let endIdx = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].inFence) continue;
      const nextH = ATX_HEADING_RE.exec(lines[j].line);
      if (nextH && nextH[1].length <= level) {
        endIdx = j;
        break;
      }
    }
    return { headingIdx: i, level, endIdx };
  }
  return null;
}
function appendMarkdown(existingMd, newMd, heading) {
  const existingNorm = normalizeLineEndings(existingMd).trimEnd();
  const addition = normalizeLineEndings(newMd).trim();
  if (!addition) return existingNorm;
  if (!heading || !heading.trim()) {
    return existingNorm ? `${existingNorm}

${addition}` : addition;
  }
  const cleanHeading = normalizeHeadingText(heading);
  if (!existingNorm) {
    return `## ${cleanHeading}

${addition}`;
  }
  const lines = parseLinesWithFences(existingNorm);
  const range = findHeadingSectionRange(lines, cleanHeading);
  if (!range) {
    return `${existingNorm}

## ${cleanHeading}

${addition}`;
  }
  const rawLines = existingNorm.split("\n");
  let insertAt = range.endIdx;
  while (insertAt > range.headingIdx + 1 && rawLines[insertAt - 1].trim() === "") {
    insertAt -= 1;
  }
  const before = rawLines.slice(0, insertAt);
  const after = rawLines.slice(range.endIdx);
  const chunks = [];
  if (before.length) chunks.push(before.join("\n").trimEnd());
  chunks.push(addition);
  if (after.length) chunks.push(after.join("\n").replace(/^\n+/, ""));
  return chunks.filter(Boolean).join("\n\n").trimEnd();
}
function replaceSectionMarkdown(existingMd, heading, newMd) {
  const existingNorm = normalizeLineEndings(existingMd);
  const lines = parseLinesWithFences(existingNorm);
  const range = findHeadingSectionRange(lines, heading);
  if (!range) {
    return { found: false, content_md: existingNorm };
  }
  const rawLines = existingNorm.split("\n");
  const headingLine = rawLines[range.headingIdx];
  const before = rawLines.slice(0, range.headingIdx);
  const after = rawLines.slice(range.endIdx);
  const replacement = normalizeLineEndings(newMd).trim();
  const parts = [];
  if (before.length) parts.push(before.join("\n").trimEnd());
  if (replacement) {
    parts.push(`${headingLine}

${replacement}`);
  } else {
    parts.push(headingLine);
  }
  if (after.length) parts.push(after.join("\n").replace(/^\n+/, ""));
  return {
    found: true,
    content_md: parts.filter((p) => p !== "").join("\n\n").trimEnd()
  };
}
function toggleTodoLine(contentMd, { lineNumber, matchText, completed }) {
  const normalized = normalizeLineEndings(contentMd);
  const lines = parseLinesWithFences(normalized);
  const rawLines = normalized.split("\n");
  const todos = [];
  for (const entry of lines) {
    if (entry.inFence) continue;
    const match = TASK_LINE_RE.exec(entry.line);
    if (!match) continue;
    const text = (match[4] ?? "").trim();
    todos.push({
      lineNumber: entry.lineNumber,
      prefix: match[1],
      currentMark: match[2],
      suffix: match[3],
      text,
      completed: match[2].toLowerCase() === "x"
    });
  }
  let target = null;
  if (lineNumber != null) {
    target = todos.find((t) => t.lineNumber === lineNumber) || null;
    if (!target) {
      return { ok: false, errorCode: "TODO_NOT_FOUND", message: `\u7B2C ${lineNumber} \u884C\u4E0D\u662F\u6709\u6548\u7684\u4EFB\u52A1\u9879` };
    }
  } else if (typeof matchText === "string" && matchText.trim()) {
    const needle = matchText.trim().toLowerCase();
    const exact = todos.filter((t) => t.text.toLowerCase() === needle);
    const candidates = exact.length > 0 ? exact : todos.filter((t) => t.text.toLowerCase().includes(needle));
    if (candidates.length === 0) {
      return { ok: false, errorCode: "TODO_NOT_FOUND", message: `\u672A\u627E\u5230\u5339\u914D "${matchText}" \u7684\u4EFB\u52A1\u9879` };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        errorCode: "AMBIGUOUS_TODO_MATCH",
        message: `\u5339\u914D\u5230 ${candidates.length} \u6761\u4EFB\u52A1\u9879\uFF0C\u8BF7\u6307\u5B9A line_number \u7CBE\u786E\u9009\u62E9`,
        candidates: candidates.map((c) => ({ line_number: c.lineNumber, text: c.text, completed: c.completed }))
      };
    }
    target = candidates[0];
  } else {
    return { ok: false, errorCode: "INVALID_INPUT", message: "\u5FC5\u987B\u63D0\u4F9B line_number \u6216 match_text" };
  }
  const nextCompleted = Boolean(completed);
  const changed = target.completed !== nextCompleted;
  const markChar = nextCompleted ? "x" : " ";
  const tail = target.text ? ` ${target.text}` : "";
  rawLines[target.lineNumber - 1] = `${target.prefix}${markChar}${target.suffix}${tail}`;
  return {
    ok: true,
    changed,
    content_md: rawLines.join("\n"),
    line_number: target.lineNumber,
    text: target.text,
    completed: nextCompleted
  };
}
function buildCarryOverSection(existingMd, sourceDate, items) {
  const heading = `\u5F85\u529E\u987A\u5EF6 (\u6765\u81EA ${sourceDate})`;
  const taskLines = items.map((item) => `- [ ] ${item.text}`).join("\n");
  const existingNorm = normalizeLineEndings(existingMd).trim();
  if (!existingNorm) {
    return `## ${heading}

${taskLines}`;
  }
  const lines = parseLinesWithFences(existingNorm);
  if (findHeadingSectionRange(lines, heading)) {
    return appendMarkdown(existingNorm, taskLines, heading);
  }
  return `## ${heading}

${taskLines}

${existingNorm}`;
}
function escapeLike(str) {
  return String(str ?? "").replace(/[\\%_]/g, "\\$&");
}
function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function buildShortSnippet(plainText, query, radius = 48) {
  const text = String(plainText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const needle = String(query ?? "").trim();
  if (!needle) {
    const truncated = text.length > radius * 2 ? `${text.slice(0, radius * 2)}\u2026` : text;
    return escapeHtml(truncated);
  }
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const hitIndex = lowerText.indexOf(lowerNeedle);
  if (hitIndex < 0) {
    const truncated = text.length > radius * 2 ? `${text.slice(0, radius * 2)}\u2026` : text;
    return escapeHtml(truncated);
  }
  const start = Math.max(0, hitIndex - radius);
  const end = Math.min(text.length, hitIndex + needle.length + radius);
  const slice = text.slice(start, end);
  let html = start > 0 ? "..." : "";
  let cursor = 0;
  const sliceLower = slice.toLowerCase();
  while (cursor < slice.length) {
    const pos = sliceLower.indexOf(lowerNeedle, cursor);
    if (pos < 0) {
      html += escapeHtml(slice.slice(cursor));
      break;
    }
    if (pos > cursor) {
      html += escapeHtml(slice.slice(cursor, pos));
    }
    html += `<mark>${escapeHtml(slice.slice(pos, pos + needle.length))}</mark>`;
    cursor = pos + needle.length;
  }
  if (end < text.length) html += "...";
  return html;
}
function formatExportMarkdown(note, { frontmatter = false } = {}) {
  const body = normalizeLineEndings(note.content_md || "").trimEnd();
  if (!frontmatter) {
    return body ? `${body}
` : "";
  }
  const tagsYaml = note.tags?.length ? `[${note.tags.map((t) => JSON.stringify(t)).join(", ")}]` : "[]";
  const projectsYaml = note.projects?.length ? `[${note.projects.map((p) => JSON.stringify(p.workspace_name || p.workspace_uri)).join(", ")}]` : "[]";
  const header = [
    "---",
    `date: ${note.date}`,
    `revision: ${note.revision ?? 0}`,
    `tags: ${tagsYaml}`,
    `projects: ${projectsYaml}`,
    `updated_at: ${JSON.stringify(note.updated_at || "")}`,
    "---",
    ""
  ].join("\n");
  return body ? `${header}${body}
` : header;
}

// ../core/src/attachments.mjs
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import path3 from "node:path";
var ATTACHMENT_ID_RE = /^[a-zA-Z0-9_-]{12,64}$/;
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var MIME_EXT_MAP = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71 && buffer[4] === 13 && buffer[5] === 10 && buffer[6] === 26 && buffer[7] === 10) {
    return "image/png";
  }
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return "image/jpeg";
  }
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") {
    return "image/gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}
function makeSafeOriginName(origName, ext) {
  const base = path3.basename(String(origName || `image.${ext}`));
  const sanitized = base.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 120);
  return sanitized || `image.${ext}`;
}
function resolveSafeAttachmentPath(attachmentsDir, relPath) {
  const root = path3.resolve(attachmentsDir);
  const resolved = path3.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path3.sep)) {
    throw Object.assign(new Error("Invalid attachment path outside storage root"), {
      code: "FORBIDDEN_PATH",
      status: 403
    });
  }
  return resolved;
}
function saveAttachment(dbCtx, { buffer, origName, noteDate }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("Empty attachment payload"), {
      code: "INVALID_ATTACHMENT",
      status: 400
    });
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error(`Attachment exceeds maximum allowed size (${MAX_ATTACHMENT_BYTES} bytes)`), {
      code: "ATTACHMENT_TOO_LARGE",
      status: 413
    });
  }
  if (noteDate != null && !isValidDateString(noteDate)) {
    throw Object.assign(new Error(`Invalid note_date: ${noteDate}`), {
      code: "INVALID_DATE",
      status: 400
    });
  }
  const mimeType = detectImageMime(buffer);
  if (!mimeType) {
    throw Object.assign(
      new Error("Unsupported image format; only PNG, JPEG, WebP, and GIF are permitted"),
      { code: "UNSUPPORTED_MEDIA_TYPE", status: 415 }
    );
  }
  const ext = MIME_EXT_MAP[mimeType];
  const datePart = noteDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const [year, month] = datePart.split("-");
  const randomSuffix = crypto2.randomBytes(9).toString("base64url");
  const id = `att_${randomSuffix}`;
  const relPath = path3.posix.join(year, month, `${id}.${ext}`);
  const absPath = resolveSafeAttachmentPath(dbCtx.attachmentsDir, relPath);
  fs2.mkdirSync(path3.dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs2.writeFileSync(tempPath, buffer);
  fs2.renameSync(tempPath, absPath);
  const sha256 = crypto2.createHash("sha256").update(buffer).digest("hex");
  const safeName = makeSafeOriginName(origName, ext);
  const createdAt = nowIso();
  try {
    dbCtx.adapter.transaction((tx) => {
      let fkNoteDate = null;
      if (noteDate) {
        const existsRow = tx.get("SELECT date FROM notes WHERE date = ?", noteDate);
        if (existsRow) fkNoteDate = noteDate;
      }
      tx.run(
        `INSERT INTO attachments (id, note_date, rel_path, orig_name, mime_type, byte_size, sha256, created_at, orphaned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        fkNoteDate,
        relPath,
        safeName,
        mimeType,
        buffer.length,
        sha256,
        createdAt
      );
    });
  } catch (err) {
    try {
      fs2.unlinkSync(absPath);
    } catch {
    }
    throw err;
  }
  return {
    id,
    url: `/api/attachments/${id}`,
    render_url: `/api/attachment?id=${id}`,
    mime_type: mimeType,
    byte_size: buffer.length,
    orig_name: safeName,
    rel_path: `attachments/${relPath}`,
    created_at: createdAt
  };
}
function getAttachment(dbCtx, id) {
  if (typeof id !== "string" || !ATTACHMENT_ID_RE.test(id)) {
    throw Object.assign(new Error("Invalid attachment ID"), {
      code: "INVALID_ATTACHMENT_ID",
      status: 400
    });
  }
  const row = dbCtx.adapter.get(
    "SELECT id, note_date, rel_path, orig_name, mime_type, byte_size, sha256, created_at, orphaned_at FROM attachments WHERE id = ?",
    id
  );
  if (!row) {
    throw Object.assign(new Error("Attachment not found"), {
      code: "ATTACHMENT_NOT_FOUND",
      status: 404
    });
  }
  const absPath = resolveSafeAttachmentPath(dbCtx.attachmentsDir, row.rel_path);
  if (!fs2.existsSync(absPath)) {
    throw Object.assign(new Error("Attachment file missing on disk"), {
      code: "ATTACHMENT_NOT_FOUND",
      status: 404
    });
  }
  return {
    ...row,
    abs_path: absPath,
    buffer: fs2.readFileSync(absPath)
  };
}
function syncNoteAttachments(tx, noteDate, currentIds, now = nowIso()) {
  const currentSet = new Set(currentIds || []);
  for (const id of currentSet) {
    if (!ATTACHMENT_ID_RE.test(id)) continue;
    tx.run(
      `UPDATE attachments
       SET orphaned_at = NULL,
           note_date = COALESCE(note_date, ?)
       WHERE id = ?`,
      noteDate,
      id
    );
  }
  const revRows = tx.all(
    "SELECT content_md FROM note_revisions WHERE note_date = ?",
    noteDate
  );
  const revisionReferenced = /* @__PURE__ */ new Set();
  for (const rev of revRows) {
    const meta = extractMetadata(rev.content_md);
    for (const id of meta.attachment_ids) {
      revisionReferenced.add(id);
    }
  }
  const ownedRows = tx.all(
    "SELECT id, orphaned_at FROM attachments WHERE note_date = ?",
    noteDate
  );
  for (const row of ownedRows) {
    if (currentSet.has(row.id) || revisionReferenced.has(row.id)) {
      if (row.orphaned_at !== null) {
        tx.run("UPDATE attachments SET orphaned_at = NULL WHERE id = ?", row.id);
      }
      continue;
    }
    const otherHit = tx.get(
      `SELECT 1 AS found FROM notes
       WHERE date != ?
         AND (content_md LIKE ? OR content_md LIKE ?)
       LIMIT 1`,
      noteDate,
      `%/api/attachments/${row.id}%`,
      `%/api/attachment?id=${row.id}%`
    );
    if (otherHit) {
      if (row.orphaned_at !== null) {
        tx.run("UPDATE attachments SET orphaned_at = NULL WHERE id = ?", row.id);
      }
      continue;
    }
    if (row.orphaned_at === null) {
      tx.run("UPDATE attachments SET orphaned_at = ? WHERE id = ?", now, row.id);
    }
  }
}
function cleanupOrphanedAttachments(dbCtx, { maxAgeDays = 7, now = /* @__PURE__ */ new Date() } = {}) {
  const cutoffMs = now.getTime() - maxAgeDays * 864e5;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const expired = dbCtx.adapter.all(
    `SELECT id, rel_path FROM attachments
     WHERE orphaned_at IS NOT NULL AND orphaned_at <= ?`,
    cutoffIso
  );
  let deletedCount = 0;
  for (const item of expired) {
    const stillReferencedInNote = dbCtx.adapter.get(
      `SELECT 1 AS found FROM notes
       WHERE content_md LIKE ? OR content_md LIKE ?
       LIMIT 1`,
      `%/api/attachments/${item.id}%`,
      `%/api/attachment?id=${item.id}%`
    );
    const stillReferencedInRev = dbCtx.adapter.get(
      `SELECT 1 AS found FROM note_revisions
       WHERE content_md LIKE ? OR content_md LIKE ?
       LIMIT 1`,
      `%/api/attachments/${item.id}%`,
      `%/api/attachment?id=${item.id}%`
    );
    if (stillReferencedInNote || stillReferencedInRev) {
      dbCtx.adapter.run("UPDATE attachments SET orphaned_at = NULL WHERE id = ?", item.id);
      continue;
    }
    try {
      const absPath = resolveSafeAttachmentPath(dbCtx.attachmentsDir, item.rel_path);
      if (fs2.existsSync(absPath)) {
        fs2.unlinkSync(absPath);
      }
    } catch {
    }
    dbCtx.adapter.run("DELETE FROM attachments WHERE id = ?", item.id);
    deletedCount += 1;
  }
  return { deletedCount };
}

// ../core/src/notes-service.mjs
import path4 from "node:path";
var MAX_REVISIONS_PER_NOTE = 50;
var CARRYOVER_LOOKBACK_DAYS = 30;
var MAX_RANGE_DAYS = 90;
var MARK_OPEN_TOKEN = "__DN_MARK_START_9F2A__";
var MARK_CLOSE_TOKEN = "__DN_MARK_END_9F2A__";
var NotesError = class extends Error {
  constructor(code, message, status = 400, details = void 0) {
    super(message);
    this.name = "NotesError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
};
function escapeHtml2(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function sanitizeFtsSnippet(rawSnippet) {
  return escapeHtml2(rawSnippet).replaceAll(MARK_OPEN_TOKEN, "<mark>").replaceAll(MARK_CLOSE_TOKEN, "</mark>");
}
function assertValidDate(dateStr) {
  if (!isValidDateString(dateStr)) {
    throw new NotesError("INVALID_DATE", `\u65E5\u671F\u683C\u5F0F\u975E\u6CD5: ${dateStr}\uFF0C\u8981\u6C42\u4E3A\u5408\u6CD5 YYYY-MM-DD`, 400);
  }
}
function assertValidMonth(monthStr) {
  if (!isValidMonthString(monthStr)) {
    throw new NotesError("INVALID_MONTH", `\u6708\u4EFD\u683C\u5F0F\u975E\u6CD5: ${monthStr}\uFF0C\u8981\u6C42\u4E3A YYYY-MM`, 400);
  }
}
function defaultWorkspaceName(workspaceUri, workspaceName) {
  if (typeof workspaceName === "string" && workspaceName.trim()) {
    return workspaceName.trim();
  }
  const clean = String(workspaceUri || "").replace(/\/+$/, "");
  const base = path4.posix.basename(clean.replace(/\\/g, "/"));
  return base || clean || "workspace";
}
function getTagsForDate(tx, date) {
  return tx.all("SELECT tag FROM note_tags WHERE note_date = ? ORDER BY tag ASC", date).map((r) => r.tag);
}
function getProjectsForDate(tx, date) {
  return tx.all(
    `SELECT workspace_uri, workspace_name, linked_by, created_at
     FROM note_projects
     WHERE note_date = ?
     ORDER BY created_at ASC`,
    date
  );
}
function getBacklinksForDate(tx, date) {
  return tx.all(
    `SELECT l.source_date AS date, n.title AS title, n.updated_at AS updated_at
     FROM note_links l
     JOIN notes n ON n.date = l.source_date
     WHERE l.target_date = ? AND length(trim(n.content_md)) > 0
     ORDER BY l.source_date DESC`,
    date
  );
}
function getTagsBatch(tx, dates) {
  const map = /* @__PURE__ */ new Map();
  if (!dates.length) return map;
  const placeholders = dates.map(() => "?").join(",");
  const rows = tx.all(
    `SELECT note_date, tag FROM note_tags WHERE note_date IN (${placeholders}) ORDER BY tag ASC`,
    ...dates
  );
  for (const row of rows) {
    if (!map.has(row.note_date)) map.set(row.note_date, []);
    map.get(row.note_date).push(row.tag);
  }
  return map;
}
function getProjectsBatch(tx, dates) {
  const map = /* @__PURE__ */ new Map();
  if (!dates.length) return map;
  const placeholders = dates.map(() => "?").join(",");
  const rows = tx.all(
    `SELECT note_date, workspace_uri, workspace_name, linked_by, created_at
     FROM note_projects
     WHERE note_date IN (${placeholders})
     ORDER BY created_at ASC`,
    ...dates
  );
  for (const row of rows) {
    if (!map.has(row.note_date)) map.set(row.note_date, []);
    map.get(row.note_date).push({
      workspace_uri: row.workspace_uri,
      workspace_name: row.workspace_name,
      linked_by: row.linked_by,
      created_at: row.created_at
    });
  }
  return map;
}
function computeYesterdayPending(tx, targetDate, noteRow) {
  const today = getLocalDateString();
  if (targetDate !== today) return null;
  if (noteRow && (noteRow.content_md.trim() !== "" || noteRow.carry_over_from || noteRow.carry_over_dismissed === 1)) {
    return null;
  }
  const minSourceDate = shiftDateString(targetDate, -CARRYOVER_LOOKBACK_DAYS);
  const candidate = tx.get(
    `SELECT date, content_md
     FROM notes
     WHERE date < ? AND date >= ? AND todo_total > todo_done AND length(trim(content_md)) > 0
     ORDER BY date DESC
     LIMIT 1`,
    targetDate,
    minSourceDate
  );
  if (!candidate) return null;
  const sourceMeta = extractMetadata(candidate.content_md);
  const openItems = sourceMeta.todos.filter((t) => !t.completed);
  if (!openItems.length) return null;
  const carriedRows = tx.all(
    "SELECT item_hash FROM todo_carryovers WHERE target_date = ? AND source_date = ?",
    targetDate,
    candidate.date
  );
  const carriedSet = new Set(carriedRows.map((r) => r.item_hash));
  const pending = openItems.filter((item) => !carriedSet.has(item.hash));
  if (!pending.length) return null;
  return {
    source_date: candidate.date,
    count: pending.length,
    items: pending.map((item) => ({ text: item.text, hash: item.hash }))
  };
}
function readFullNote(tx, date) {
  const row = tx.get("SELECT * FROM notes WHERE date = ?", date);
  const backlinks = getBacklinksForDate(tx, date);
  if (!row) {
    return {
      date,
      exists: false,
      title: "",
      content_md: "",
      plain_text: "",
      word_count: 0,
      todo_total: 0,
      todo_done: 0,
      revision: 0,
      last_editor: "user",
      carry_over_from: null,
      carry_over_dismissed: 0,
      created_at: null,
      updated_at: null,
      last_agent_at: null,
      tags: [],
      projects: [],
      backlinks,
      yesterday_pending: computeYesterdayPending(tx, date, null)
    };
  }
  return {
    date: row.date,
    exists: true,
    title: row.title,
    content_md: row.content_md,
    plain_text: row.plain_text,
    word_count: row.word_count,
    todo_total: row.todo_total,
    todo_done: row.todo_done,
    revision: row.revision,
    last_editor: row.last_editor,
    carry_over_from: row.carry_over_from,
    carry_over_dismissed: row.carry_over_dismissed,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_agent_at: row.last_agent_at,
    tags: getTagsForDate(tx, date),
    projects: getProjectsForDate(tx, date),
    backlinks,
    yesterday_pending: computeYesterdayPending(tx, date, row)
  };
}
function insertRevisionSnapshot(tx, { noteDate, revision, contentMd, source, summary = "", createdAt = nowIso() }) {
  const info = tx.run(
    `INSERT INTO note_revisions (note_date, revision, content_md, source, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    noteDate,
    revision,
    contentMd,
    source,
    summary,
    createdAt
  );
  const snapshotId = Number(info.lastInsertRowid);
  tx.run(
    `DELETE FROM note_revisions
     WHERE note_date = ?
       AND id NOT IN (
         SELECT id FROM note_revisions
         WHERE note_date = ?
         ORDER BY id DESC
         LIMIT ?
       )`,
    noteDate,
    noteDate,
    MAX_REVISIONS_PER_NOTE
  );
  return snapshotId;
}
function rebuildDerivedIndices(tx, noteDate, meta, now) {
  tx.run("DELETE FROM note_tags WHERE note_date = ?", noteDate);
  for (const tag of meta.tags) {
    tx.run("INSERT INTO note_tags (note_date, tag) VALUES (?, ?)", noteDate, tag);
  }
  tx.run("DELETE FROM note_links WHERE source_date = ?", noteDate);
  for (const targetDate of meta.links) {
    tx.run("INSERT INTO note_links (source_date, target_date) VALUES (?, ?)", noteDate, targetDate);
  }
  syncNoteAttachments(tx, noteDate, meta.attachment_ids, now);
}
function writeNoteContent(tx, {
  date,
  nextMd,
  editor = "user",
  existingRow = null,
  now = nowIso(),
  carryOverFrom = void 0,
  carryOverDismissed = void 0
}) {
  const normalized = normalizeLineEndings(nextMd);
  const meta = extractMetadata(normalized);
  if (!existingRow) {
    const lastAgentAt = editor === "agent" ? now : null;
    tx.run(
      `INSERT INTO notes (
         date, title, content_md, plain_text, word_count, todo_total, todo_done,
         revision, last_editor, carry_over_from, carry_over_dismissed,
         created_at, updated_at, last_agent_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      date,
      meta.title,
      normalized,
      meta.plain_text,
      meta.word_count,
      meta.todo_total,
      meta.todo_done,
      editor,
      carryOverFrom ?? null,
      carryOverDismissed ?? 0,
      now,
      now,
      lastAgentAt
    );
  } else {
    const nextRevision = existingRow.revision + 1;
    const nextLastAgentAt = editor === "agent" ? now : existingRow.last_agent_at;
    const nextCarryOverFrom = carryOverFrom !== void 0 ? carryOverFrom : existingRow.carry_over_from;
    const nextCarryOverDismissed = carryOverDismissed !== void 0 ? carryOverDismissed : existingRow.carry_over_dismissed;
    tx.run(
      `UPDATE notes
       SET title = ?,
           content_md = ?,
           plain_text = ?,
           word_count = ?,
           todo_total = ?,
           todo_done = ?,
           revision = ?,
           last_editor = ?,
           carry_over_from = ?,
           carry_over_dismissed = ?,
           updated_at = ?,
           last_agent_at = ?
       WHERE date = ?`,
      meta.title,
      normalized,
      meta.plain_text,
      meta.word_count,
      meta.todo_total,
      meta.todo_done,
      nextRevision,
      editor,
      nextCarryOverFrom,
      nextCarryOverDismissed,
      now,
      nextLastAgentAt,
      date
    );
  }
  rebuildDerivedIndices(tx, date, meta, now);
}
function createNotesService(dbCtx) {
  const { adapter } = dbCtx;
  return {
    getHealth({ mode = "standalone" } = {}) {
      return {
        status: "ok",
        data_dir: dbCtx.dataDir,
        db_path: dbCtx.dbPath,
        schema_version: dbCtx.schemaVersion,
        mode
      };
    },
    getNote(date = getLocalDateString()) {
      assertValidDate(date);
      return readFullNote(adapter, date);
    },
    getNoteMeta(date = getLocalDateString()) {
      assertValidDate(date);
      const row = adapter.get(
        `SELECT date, revision, updated_at, last_editor, last_agent_at, todo_total, todo_done
         FROM notes
         WHERE date = ?`,
        date
      );
      if (!row) {
        return {
          date,
          exists: false,
          revision: 0,
          updated_at: null,
          last_editor: "user",
          last_agent_at: null,
          todo_total: 0,
          todo_done: 0
        };
      }
      return {
        date: row.date,
        exists: true,
        revision: row.revision,
        updated_at: row.updated_at,
        last_editor: row.last_editor,
        last_agent_at: row.last_agent_at,
        todo_total: row.todo_total,
        todo_done: row.todo_done
      };
    },
    saveNote(date, {
      content_md,
      expected_revision,
      force = false,
      editor = "user",
      checkpoint_source = null,
      checkpoint_summary = ""
    } = {}) {
      assertValidDate(date);
      if (typeof content_md !== "string") {
        throw new NotesError("INVALID_INPUT", "content_md \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32", 400);
      }
      return adapter.transaction((tx) => {
        const existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        const currentRevision = existing ? existing.revision : 0;
        const normalized = normalizeLineEndings(content_md);
        if (!force && expected_revision !== void 0 && expected_revision !== null) {
          const expectedNum = Number(expected_revision);
          if (!Number.isInteger(expectedNum) || expectedNum < 0) {
            throw new NotesError("INVALID_REVISION", "expected_revision \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570", 400);
          }
          if (expectedNum !== currentRevision) {
            throw new NotesError(
              "REVISION_CONFLICT",
              `\u7248\u672C\u51B2\u7A81\uFF1A\u671F\u671B rev ${expectedNum}\uFF0C\u5F53\u524D\u670D\u52A1\u7AEF\u4E3A rev ${currentRevision}`,
              409,
              {
                expected_revision: expectedNum,
                current_revision: currentRevision,
                server_note: readFullNote(tx, date)
              }
            );
          }
        }
        if (!existing && normalized.trim() === "" && !checkpoint_source) {
          return readFullNote(tx, date);
        }
        const now = nowIso();
        if (existing && force && expected_revision != null && Number(expected_revision) !== currentRevision) {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: "restore_backup",
            summary: "\u51B2\u7A81\u65F6\u88AB\u672C\u5730\u5F3A\u5236\u8986\u76D6\u524D\u5907\u4EFD",
            createdAt: now
          });
        } else if (existing && checkpoint_source) {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: checkpoint_source,
            summary: checkpoint_summary,
            createdAt: now
          });
        }
        writeNoteContent(tx, {
          date,
          nextMd: normalized,
          editor,
          existingRow: existing,
          now
        });
        return readFullNote(tx, date);
      });
    },
    appendNote({
      date = getLocalDateString(),
      markdown,
      heading,
      workspace_uri,
      workspace_name,
      summary = ""
    } = {}) {
      assertValidDate(date);
      if (typeof markdown !== "string" || markdown.trim() === "") {
        throw new NotesError("INVALID_INPUT", "markdown \u4E0D\u80FD\u4E3A\u7A7A", 400);
      }
      return adapter.transaction((tx) => {
        const now = nowIso();
        let existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        let snapshotId = null;
        if (!existing) {
          tx.run(
            `INSERT INTO notes (
               date, title, content_md, plain_text, word_count, todo_total, todo_done,
               revision, last_editor, carry_over_from, carry_over_dismissed,
               created_at, updated_at, last_agent_at
             ) VALUES (?, '', '', '', 0, 0, 0, 0, 'agent', NULL, 0, ?, ?, ?)`,
            date,
            now,
            now,
            now
          );
          existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
          snapshotId = insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: 0,
            contentMd: "",
            source: "agent",
            summary: summary || "Agent \u5199\u5165\u65B0\u7B14\u8BB0\u524D\u7A7A\u5FEB\u7167",
            createdAt: now
          });
        } else {
          snapshotId = insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: "agent",
            summary: summary || "Agent \u8FFD\u52A0\u5185\u5BB9\u524D\u5FEB\u7167",
            createdAt: now
          });
        }
        const nextMd = appendMarkdown(existing.content_md, markdown, heading);
        writeNoteContent(tx, {
          date,
          nextMd,
          editor: "agent",
          existingRow: existing,
          now
        });
        if (typeof workspace_uri === "string" && workspace_uri.trim()) {
          const cleanUri = workspace_uri.trim();
          const wsName = defaultWorkspaceName(cleanUri, workspace_name);
          tx.run(
            `INSERT INTO note_projects (note_date, workspace_uri, workspace_name, linked_by, created_at)
             VALUES (?, ?, ?, 'agent', ?)
             ON CONFLICT(note_date, workspace_uri) DO UPDATE SET workspace_name = excluded.workspace_name`,
            date,
            cleanUri,
            wsName,
            now
          );
        }
        return {
          note: readFullNote(tx, date),
          snapshot_id: snapshotId
        };
      });
    },
    toggleTodo({
      date = getLocalDateString(),
      expected_revision,
      line_number,
      match_text,
      completed,
      editor = "agent",
      summary = ""
    } = {}) {
      assertValidDate(date);
      if (expected_revision === void 0 || expected_revision === null || !Number.isInteger(Number(expected_revision))) {
        throw new NotesError("INVALID_REVISION", "\u5FC5\u987B\u63D0\u4F9B\u6574\u6570 expected_revision", 400);
      }
      if (typeof completed !== "boolean") {
        throw new NotesError("INVALID_INPUT", "completed \u5FC5\u987B\u4E3A\u5E03\u5C14\u503C", 400);
      }
      const expectedRev = Number(expected_revision);
      return adapter.transaction((tx) => {
        const existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        const currentRev = existing ? existing.revision : 0;
        if (expectedRev !== currentRev) {
          throw new NotesError(
            "REVISION_CONFLICT",
            `\u7248\u672C\u51B2\u7A81\uFF1A\u671F\u671B rev ${expectedRev}\uFF0C\u5F53\u524D\u670D\u52A1\u7AEF\u4E3A rev ${currentRev}`,
            409,
            {
              expected_revision: expectedRev,
              current_revision: currentRev,
              server_note: readFullNote(tx, date)
            }
          );
        }
        if (!existing) {
          throw new NotesError("NOTE_NOT_FOUND", `${date} \u6682\u65E0\u7B14\u8BB0\u5185\u5BB9`, 404);
        }
        const toggled = toggleTodoLine(existing.content_md, {
          lineNumber: line_number != null ? Number(line_number) : void 0,
          matchText: match_text,
          completed
        });
        if (!toggled.ok) {
          const status = toggled.errorCode === "TODO_NOT_FOUND" ? 404 : toggled.errorCode === "INVALID_INPUT" ? 400 : 409;
          throw new NotesError(
            toggled.errorCode,
            toggled.message,
            status,
            toggled.candidates ? { candidates: toggled.candidates } : void 0
          );
        }
        if (!toggled.changed) {
          return {
            note: readFullNote(tx, date),
            changed: false,
            line_number: toggled.line_number,
            text: toggled.text,
            completed: toggled.completed,
            snapshot_id: null
          };
        }
        const now = nowIso();
        const snapshotId = insertRevisionSnapshot(tx, {
          noteDate: date,
          revision: existing.revision,
          contentMd: existing.content_md,
          source: editor === "agent" ? "agent" : "manual_checkpoint",
          summary: summary || `\u5207\u6362\u5F85\u529E\u72B6\u6001: ${toggled.text.slice(0, 60)}`,
          createdAt: now
        });
        writeNoteContent(tx, {
          date,
          nextMd: toggled.content_md,
          editor,
          existingRow: existing,
          now
        });
        return {
          note: readFullNote(tx, date),
          changed: true,
          line_number: toggled.line_number,
          text: toggled.text,
          completed: toggled.completed,
          snapshot_id: snapshotId
        };
      });
    },
    updateNoteControlled({
      date = getLocalDateString(),
      expected_revision,
      mode,
      heading,
      markdown,
      summary
    } = {}) {
      assertValidDate(date);
      if (expected_revision === void 0 || expected_revision === null || !Number.isInteger(Number(expected_revision))) {
        throw new NotesError("INVALID_REVISION", "\u5FC5\u987B\u63D0\u4F9B\u6574\u6570 expected_revision", 400);
      }
      if (mode !== "replace" && mode !== "replace_section") {
        throw new NotesError("INVALID_INPUT", "mode \u5FC5\u987B\u4E3A replace \u6216 replace_section", 400);
      }
      if (mode === "replace_section" && (typeof heading !== "string" || !heading.trim())) {
        throw new NotesError("INVALID_INPUT", "mode \u4E3A replace_section \u65F6\u5FC5\u987B\u63D0\u4F9B heading", 400);
      }
      if (typeof markdown !== "string") {
        throw new NotesError("INVALID_INPUT", "markdown \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32", 400);
      }
      if (typeof summary !== "string" || !summary.trim()) {
        throw new NotesError("INVALID_INPUT", "\u5FC5\u987B\u63D0\u4F9B\u975E\u7A7A summary \u8BF4\u660E\u4FEE\u6539\u610F\u56FE", 400);
      }
      const expectedRev = Number(expected_revision);
      return adapter.transaction((tx) => {
        const now = nowIso();
        let existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        const currentRev = existing ? existing.revision : 0;
        if (expectedRev !== currentRev) {
          throw new NotesError(
            "REVISION_CONFLICT",
            `\u7248\u672C\u51B2\u7A81\uFF1A\u671F\u671B rev ${expectedRev}\uFF0C\u5F53\u524D\u670D\u52A1\u7AEF\u4E3A rev ${currentRev}`,
            409,
            {
              expected_revision: expectedRev,
              current_revision: currentRev,
              server_note: readFullNote(tx, date)
            }
          );
        }
        let nextMd;
        if (mode === "replace") {
          nextMd = normalizeLineEndings(markdown);
        } else {
          if (!existing) {
            throw new NotesError("HEADING_NOT_FOUND", `${date} \u5C1A\u672A\u521B\u5EFA\u7B14\u8BB0\uFF0C\u627E\u4E0D\u5230\u5C0F\u8282 "${heading}"`, 404);
          }
          const replaced = replaceSectionMarkdown(existing.content_md, heading, markdown);
          if (!replaced.found) {
            throw new NotesError("HEADING_NOT_FOUND", `\u672A\u627E\u5230\u6807\u9898\u4E3A "${heading}" \u7684\u5C0F\u8282`, 404);
          }
          nextMd = replaced.content_md;
        }
        if (!existing) {
          tx.run(
            `INSERT INTO notes (
               date, title, content_md, plain_text, word_count, todo_total, todo_done,
               revision, last_editor, carry_over_from, carry_over_dismissed,
               created_at, updated_at, last_agent_at
             ) VALUES (?, '', '', '', 0, 0, 0, 0, 'agent', NULL, 0, ?, ?, ?)`,
            date,
            now,
            now,
            now
          );
          existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        }
        const snapshotId = insertRevisionSnapshot(tx, {
          noteDate: date,
          revision: existing.revision,
          contentMd: existing.content_md,
          source: "agent",
          summary: summary.trim(),
          createdAt: now
        });
        writeNoteContent(tx, {
          date,
          nextMd,
          editor: "agent",
          existingRow: existing,
          now
        });
        return {
          note: readFullNote(tx, date),
          snapshot_id: snapshotId
        };
      });
    },
    carryOverTodos(date, { action = "apply", source_date } = {}) {
      assertValidDate(date);
      if (action !== "apply" && action !== "dismiss") {
        throw new NotesError("INVALID_INPUT", "action \u5FC5\u987B\u4E3A apply \u6216 dismiss", 400);
      }
      if (source_date != null) {
        assertValidDate(source_date);
      }
      return adapter.transaction((tx) => {
        const now = nowIso();
        const existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        if (action === "dismiss") {
          if (!existing) {
            tx.run(
              `INSERT INTO notes (
                 date, title, content_md, plain_text, word_count, todo_total, todo_done,
                 revision, last_editor, carry_over_from, carry_over_dismissed,
                 created_at, updated_at, last_agent_at
               ) VALUES (?, '', '', '', 0, 0, 0, 1, 'user', NULL, 1, ?, ?, NULL)`,
              date,
              now,
              now
            );
          } else {
            tx.run(
              "UPDATE notes SET carry_over_dismissed = 1, updated_at = ? WHERE date = ?",
              now,
              date
            );
          }
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: 0
          };
        }
        let sourceRow = null;
        if (source_date) {
          sourceRow = tx.get("SELECT date, content_md FROM notes WHERE date = ?", source_date);
        } else {
          const minDate = shiftDateString(date, -CARRYOVER_LOOKBACK_DAYS);
          sourceRow = tx.get(
            `SELECT date, content_md
             FROM notes
             WHERE date < ? AND date >= ? AND todo_total > todo_done AND length(trim(content_md)) > 0
             ORDER BY date DESC
             LIMIT 1`,
            date,
            minDate
          );
        }
        if (!sourceRow) {
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: 0
          };
        }
        const sourceMeta = extractMetadata(sourceRow.content_md);
        const openItems = sourceMeta.todos.filter((t) => !t.completed);
        if (!openItems.length) {
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: 0
          };
        }
        const carriedRows = tx.all(
          "SELECT item_hash FROM todo_carryovers WHERE target_date = ? AND source_date = ?",
          date,
          sourceRow.date
        );
        const carriedSet = new Set(carriedRows.map((r) => r.item_hash));
        const toCarry = [];
        const seenInBatch = /* @__PURE__ */ new Set();
        let skippedCount = 0;
        for (const item of openItems) {
          if (carriedSet.has(item.hash) || seenInBatch.has(item.hash)) {
            skippedCount += 1;
            continue;
          }
          seenInBatch.add(item.hash);
          toCarry.push(item);
        }
        if (!toCarry.length) {
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: skippedCount
          };
        }
        if (existing && existing.content_md.trim() !== "") {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: "carry_over_backup",
            summary: `\u987A\u5EF6\u6765\u81EA ${sourceRow.date} \u7684 ${toCarry.length} \u9879\u5F85\u529E\u524D\u5907\u4EFD`,
            createdAt: now
          });
        }
        const nextMd = buildCarryOverSection(existing ? existing.content_md : "", sourceRow.date, toCarry);
        writeNoteContent(tx, {
          date,
          nextMd,
          editor: existing ? existing.last_editor : "system",
          existingRow: existing,
          now,
          carryOverFrom: existing?.carry_over_from || sourceRow.date,
          carryOverDismissed: 0
        });
        for (const item of toCarry) {
          tx.run(
            `INSERT OR IGNORE INTO todo_carryovers (target_date, source_date, item_hash, carried_at)
             VALUES (?, ?, ?, ?)`,
            date,
            sourceRow.date,
            item.hash,
            now
          );
        }
        return {
          note: readFullNote(tx, date),
          carried_count: toCarry.length,
          skipped_count: skippedCount
        };
      });
    },
    linkProject(date, { workspace_uri, workspace_name, linked_by = "user" } = {}) {
      assertValidDate(date);
      if (typeof workspace_uri !== "string" || !workspace_uri.trim()) {
        throw new NotesError("INVALID_INPUT", "workspace_uri \u4E0D\u80FD\u4E3A\u7A7A", 400);
      }
      const cleanUri = workspace_uri.trim();
      const wsName = defaultWorkspaceName(cleanUri, workspace_name);
      const role = linked_by === "agent" ? "agent" : "user";
      return adapter.transaction((tx) => {
        const now = nowIso();
        const existing = tx.get("SELECT date FROM notes WHERE date = ?", date);
        if (!existing) {
          tx.run(
            `INSERT INTO notes (
               date, title, content_md, plain_text, word_count, todo_total, todo_done,
               revision, last_editor, carry_over_from, carry_over_dismissed,
               created_at, updated_at, last_agent_at
             ) VALUES (?, '', '', '', 0, 0, 0, 1, ?, NULL, 0, ?, ?, NULL)`,
            date,
            role,
            now,
            now
          );
        }
        tx.run(
          `INSERT INTO note_projects (note_date, workspace_uri, workspace_name, linked_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(note_date, workspace_uri) DO UPDATE SET
             workspace_name = excluded.workspace_name`,
          date,
          cleanUri,
          wsName,
          role,
          now
        );
        return {
          projects: getProjectsForDate(tx, date)
        };
      });
    },
    unlinkProject(date, workspaceUri) {
      assertValidDate(date);
      if (typeof workspaceUri !== "string" || !workspaceUri.trim()) {
        throw new NotesError("INVALID_INPUT", "workspace_uri \u4E0D\u80FD\u4E3A\u7A7A", 400);
      }
      return adapter.transaction((tx) => {
        tx.run(
          "DELETE FROM note_projects WHERE note_date = ? AND workspace_uri = ?",
          date,
          workspaceUri.trim()
        );
        return {
          projects: getProjectsForDate(tx, date)
        };
      });
    },
    listAllProjects() {
      return {
        projects: adapter.all(
          `SELECT p.workspace_uri, MAX(p.workspace_name) AS workspace_name, COUNT(*) AS count
           FROM note_projects p
           JOIN notes n ON n.date = p.note_date
           WHERE length(trim(n.content_md)) > 0
           GROUP BY p.workspace_uri
           ORDER BY count DESC, workspace_name ASC`
        )
      };
    },
    getCalendar({ month, tag = "", workspace_uri = "" } = {}) {
      assertValidMonth(month);
      const { startDate, endDate } = monthDateBounds(month);
      const cleanTag = String(tag || "").trim().replace(/^#/, "").toLowerCase();
      const cleanWs = String(workspace_uri || "").trim();
      const whereClauses = [
        "n.date >= ?",
        "n.date <= ?",
        "length(trim(n.content_md)) > 0"
      ];
      const params = [startDate, endDate];
      if (cleanTag) {
        whereClauses.push("EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)");
        params.push(cleanTag);
      }
      if (cleanWs) {
        whereClauses.push(
          "EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)"
        );
        params.push(cleanWs);
      }
      const rows = adapter.all(
        `SELECT n.date, n.todo_total, n.todo_done
         FROM notes n
         WHERE ${whereClauses.join(" AND ")}`,
        ...params
      );
      const byDate = new Map(rows.map((r) => [r.date, r]));
      const totalDays = Number(endDate.slice(-2));
      const days = [];
      for (let d = 1; d <= totalDays; d++) {
        const dateStr = `${month}-${String(d).padStart(2, "0")}`;
        const hit = byDate.get(dateStr);
        days.push({
          date: dateStr,
          has_note: Boolean(hit),
          todo_total: hit ? hit.todo_total : 0,
          todo_done: hit ? hit.todo_done : 0
        });
      }
      return { month, days };
    },
    searchNotes({
      q = "",
      tag = "",
      workspace_uri = "",
      from = "",
      to = "",
      limit = 30,
      offset = 0
    } = {}) {
      const cleanQuery = String(q || "").trim();
      const cleanTag = String(tag || "").trim().replace(/^#/, "").toLowerCase();
      const cleanWs = String(workspace_uri || "").trim();
      const cleanFrom = String(from || "").trim();
      const cleanTo = String(to || "").trim();
      if (cleanFrom) assertValidDate(cleanFrom);
      if (cleanTo) assertValidDate(cleanTo);
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const filterClauses = ["length(trim(n.content_md)) > 0"];
      const filterParams = [];
      if (cleanTag) {
        filterClauses.push("EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)");
        filterParams.push(cleanTag);
      }
      if (cleanWs) {
        filterClauses.push(
          "EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)"
        );
        filterParams.push(cleanWs);
      }
      if (cleanFrom) {
        filterClauses.push("n.date >= ?");
        filterParams.push(cleanFrom);
      }
      if (cleanTo) {
        filterClauses.push("n.date <= ?");
        filterParams.push(cleanTo);
      }
      let total = 0;
      let rows = [];
      if (cleanQuery.length >= 3) {
        const ftsQuery = `"${cleanQuery.replace(/"/g, '""')}"`;
        const whereSql = ["notes_fts MATCH ?", ...filterClauses].join(" AND ");
        const countRow = adapter.get(
          `SELECT COUNT(*) AS cnt
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE ${whereSql}`,
          ftsQuery,
          ...filterParams
        );
        total = Number(countRow?.cnt || 0);
        rows = adapter.all(
          `SELECT
             n.date,
             n.title,
             n.plain_text,
             n.content_md,
             n.todo_total,
             n.todo_done,
             n.updated_at,
             snippet(notes_fts, 2, ?, ?, '...', 24) AS raw_plain_snippet,
             snippet(notes_fts, 1, ?, ?, '...', 24) AS raw_md_snippet
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE ${whereSql}
           ORDER BY bm25(notes_fts), n.date DESC
           LIMIT ? OFFSET ?`,
          MARK_OPEN_TOKEN,
          MARK_CLOSE_TOKEN,
          MARK_OPEN_TOKEN,
          MARK_CLOSE_TOKEN,
          ftsQuery,
          ...filterParams,
          safeLimit,
          safeOffset
        );
      } else if (cleanQuery.length > 0) {
        const likePattern = `%${escapeLike(cleanQuery)}%`;
        const whereSql = [
          "(n.plain_text LIKE ? ESCAPE '\\' OR n.content_md LIKE ? ESCAPE '\\')",
          ...filterClauses
        ].join(" AND ");
        const countRow = adapter.get(
          `SELECT COUNT(*) AS cnt FROM notes n WHERE ${whereSql}`,
          likePattern,
          likePattern,
          ...filterParams
        );
        total = Number(countRow?.cnt || 0);
        rows = adapter.all(
          `SELECT n.date, n.title, n.plain_text, n.content_md, n.todo_total, n.todo_done, n.updated_at
           FROM notes n
           WHERE ${whereSql}
           ORDER BY n.date DESC
           LIMIT ? OFFSET ?`,
          likePattern,
          likePattern,
          ...filterParams,
          safeLimit,
          safeOffset
        );
      } else {
        const whereSql = filterClauses.join(" AND ");
        const countRow = adapter.get(
          `SELECT COUNT(*) AS cnt FROM notes n WHERE ${whereSql}`,
          ...filterParams
        );
        total = Number(countRow?.cnt || 0);
        rows = adapter.all(
          `SELECT n.date, n.title, n.plain_text, n.content_md, n.todo_total, n.todo_done, n.updated_at
           FROM notes n
           WHERE ${whereSql}
           ORDER BY n.date DESC
           LIMIT ? OFFSET ?`,
          ...filterParams,
          safeLimit,
          safeOffset
        );
      }
      const dates = rows.map((r) => r.date);
      const tagsMap = getTagsBatch(adapter, dates);
      const projectsMap = getProjectsBatch(adapter, dates);
      const items = rows.map((r) => {
        let snippetHtml;
        if (cleanQuery.length >= 3) {
          if (r.raw_plain_snippet && r.raw_plain_snippet.includes(MARK_OPEN_TOKEN)) {
            snippetHtml = sanitizeFtsSnippet(r.raw_plain_snippet);
          } else if (r.raw_md_snippet && r.raw_md_snippet.includes(MARK_OPEN_TOKEN)) {
            snippetHtml = sanitizeFtsSnippet(r.raw_md_snippet);
          } else {
            snippetHtml = buildShortSnippet(r.plain_text || r.content_md, cleanQuery, 48);
          }
        } else {
          snippetHtml = buildShortSnippet(r.plain_text || r.content_md, cleanQuery, 48);
        }
        return {
          date: r.date,
          title: r.title,
          snippet: snippetHtml,
          todo_total: r.todo_total,
          todo_done: r.todo_done,
          tags: tagsMap.get(r.date) || [],
          projects: projectsMap.get(r.date) || [],
          updated_at: r.updated_at
        };
      });
      return { total, items };
    },
    listRange({
      start_date,
      end_date,
      tag = "",
      workspace_uri = "",
      include_content = false
    } = {}) {
      assertValidDate(start_date);
      assertValidDate(end_date);
      const span = daysBetween(start_date, end_date);
      if (span < 0) {
        throw new NotesError("INVALID_RANGE", "start_date \u4E0D\u80FD\u665A\u4E8E end_date", 400);
      }
      if (span > MAX_RANGE_DAYS) {
        throw new NotesError("RANGE_TOO_LARGE", `\u5355\u6B21\u67E5\u8BE2\u8DE8\u5EA6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_RANGE_DAYS} \u5929`, 400);
      }
      const cleanTag = String(tag || "").trim().replace(/^#/, "").toLowerCase();
      const cleanWs = String(workspace_uri || "").trim();
      const clauses = [
        "n.date >= ?",
        "n.date <= ?",
        "length(trim(n.content_md)) > 0"
      ];
      const params = [start_date, end_date];
      if (cleanTag) {
        clauses.push("EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)");
        params.push(cleanTag);
      }
      if (cleanWs) {
        clauses.push(
          "EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)"
        );
        params.push(cleanWs);
      }
      const rows = adapter.all(
        `SELECT n.date, n.title, n.plain_text, n.content_md, n.word_count,
                n.todo_total, n.todo_done, n.revision, n.updated_at
         FROM notes n
         WHERE ${clauses.join(" AND ")}
         ORDER BY n.date DESC`,
        ...params
      );
      const dates = rows.map((r) => r.date);
      const tagsMap = getTagsBatch(adapter, dates);
      const projectsMap = getProjectsBatch(adapter, dates);
      return {
        start_date,
        end_date,
        notes: rows.map((r) => {
          const item = {
            date: r.date,
            title: r.title,
            preview: r.plain_text.length > 160 ? `${r.plain_text.slice(0, 160)}\u2026` : r.plain_text,
            word_count: r.word_count,
            todo_total: r.todo_total,
            todo_done: r.todo_done,
            revision: r.revision,
            tags: tagsMap.get(r.date) || [],
            projects: projectsMap.get(r.date) || [],
            updated_at: r.updated_at
          };
          if (include_content) {
            item.content_md = r.content_md;
          }
          return item;
        })
      };
    },
    getOpenTodos({ days = 7, start_date, end_date, workspace_uri = "" } = {}) {
      const today = getLocalDateString();
      const resolvedEnd = end_date || today;
      assertValidDate(resolvedEnd);
      const safeDays = Math.min(MAX_RANGE_DAYS, Math.max(1, Number(days) || 7));
      const resolvedStart = start_date || shiftDateString(resolvedEnd, -(safeDays - 1));
      assertValidDate(resolvedStart);
      const span = daysBetween(resolvedStart, resolvedEnd);
      if (span < 0) {
        throw new NotesError("INVALID_RANGE", "start_date \u4E0D\u80FD\u665A\u4E8E end_date", 400);
      }
      if (span > MAX_RANGE_DAYS) {
        throw new NotesError("RANGE_TOO_LARGE", `\u5355\u6B21\u5F85\u529E\u626B\u63CF\u8DE8\u5EA6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_RANGE_DAYS} \u5929`, 400);
      }
      const cleanWs = String(workspace_uri || "").trim();
      const clauses = [
        "n.date >= ?",
        "n.date <= ?",
        "n.todo_total > n.todo_done",
        "length(trim(n.content_md)) > 0"
      ];
      const params = [resolvedStart, resolvedEnd];
      if (cleanWs) {
        clauses.push(
          "EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)"
        );
        params.push(cleanWs);
      }
      const rows = adapter.all(
        `SELECT n.date, n.revision, n.content_md
         FROM notes n
         WHERE ${clauses.join(" AND ")}
         ORDER BY n.date DESC`,
        ...params
      );
      const items = [];
      for (const row of rows) {
        const meta = extractMetadata(row.content_md);
        for (const todo of meta.todos) {
          if (!todo.completed) {
            items.push({
              date: row.date,
              revision: row.revision,
              line_number: todo.lineNumber,
              text: todo.text
            });
          }
        }
      }
      return {
        start_date: resolvedStart,
        end_date: resolvedEnd,
        total_open: items.length,
        items
      };
    },
    listTags({ q = "" } = {}) {
      const prefix = String(q || "").trim().replace(/^#/, "").toLowerCase();
      const clauses = ["length(trim(n.content_md)) > 0"];
      const params = [];
      if (prefix) {
        clauses.push("t.tag LIKE ? ESCAPE '\\'");
        params.push(`${escapeLike(prefix)}%`);
      }
      const tags = adapter.all(
        `SELECT t.tag, COUNT(*) AS count
         FROM note_tags t
         JOIN notes n ON n.date = t.note_date
         WHERE ${clauses.join(" AND ")}
         GROUP BY t.tag
         ORDER BY count DESC, t.tag ASC`,
        ...params
      );
      return { tags };
    },
    listRevisions(date, { limit = 50 } = {}) {
      assertValidDate(date);
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
      const rows = adapter.all(
        `SELECT id, note_date, revision, content_md, source, summary, created_at
         FROM note_revisions
         WHERE note_date = ?
         ORDER BY id DESC
         LIMIT ?`,
        date,
        safeLimit
      );
      return {
        revisions: rows.map((r) => ({
          id: r.id,
          revision: r.revision,
          source: r.source,
          summary: r.summary,
          created_at: r.created_at,
          content_md: r.content_md,
          preview: r.content_md.length > 200 ? `${r.content_md.slice(0, 200)}\u2026` : r.content_md
        }))
      };
    },
    restoreRevision(date, revisionId, { expected_revision } = {}) {
      assertValidDate(date);
      const idNum = Number(revisionId);
      if (!Number.isInteger(idNum) || idNum <= 0) {
        throw new NotesError("INVALID_INPUT", "\u5FEB\u7167 ID \u975E\u6CD5", 400);
      }
      return adapter.transaction((tx) => {
        const targetRev = tx.get(
          "SELECT * FROM note_revisions WHERE id = ? AND note_date = ?",
          idNum,
          date
        );
        if (!targetRev) {
          throw new NotesError("REVISION_NOT_FOUND", `\u672A\u627E\u5230\u5FEB\u7167 #${idNum}`, 404);
        }
        const existing = tx.get("SELECT * FROM notes WHERE date = ?", date);
        const currentRev = existing ? existing.revision : 0;
        if (expected_revision !== void 0 && expected_revision !== null) {
          const expectedNum = Number(expected_revision);
          if (expectedNum !== currentRev) {
            throw new NotesError(
              "REVISION_CONFLICT",
              `\u7248\u672C\u51B2\u7A81\uFF1A\u671F\u671B rev ${expectedNum}\uFF0C\u5F53\u524D\u670D\u52A1\u7AEF\u4E3A rev ${currentRev}`,
              409,
              {
                expected_revision: expectedNum,
                current_revision: currentRev,
                server_note: readFullNote(tx, date)
              }
            );
          }
        }
        const now = nowIso();
        if (existing) {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: "restore_backup",
            summary: `\u6062\u590D\u81F3\u5FEB\u7167 rev ${targetRev.revision} \u524D\u7684\u81EA\u52A8\u5907\u4EFD`,
            createdAt: now
          });
        }
        writeNoteContent(tx, {
          date,
          nextMd: targetRev.content_md,
          editor: "user",
          existingRow: existing,
          now
        });
        return readFullNote(tx, date);
      });
    },
    exportNote(date, { frontmatter = false } = {}) {
      assertValidDate(date);
      const note = readFullNote(adapter, date);
      return {
        date,
        filename: `${date}.md`,
        markdown: formatExportMarkdown(note, { frontmatter: Boolean(frontmatter) })
      };
    },
    listRecentNotes({ limit = 60, offset = 0 } = {}) {
      const safeLimit = Math.min(200, Math.max(1, Number(limit) || 60));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const total = adapter.get(
        "SELECT COUNT(*) AS cnt FROM notes WHERE length(trim(content_md)) > 0"
      ).cnt;
      const rows = adapter.all(
        `SELECT date, title, word_count, todo_total, todo_done, revision, updated_at
         FROM notes
         WHERE length(trim(content_md)) > 0
         ORDER BY date DESC
         LIMIT ? OFFSET ?`,
        safeLimit,
        safeOffset
      );
      const dates = rows.map((r) => r.date);
      const tagsMap = getTagsBatch(adapter, dates);
      const projectsMap = getProjectsBatch(adapter, dates);
      return {
        total,
        notes: rows.map((r) => ({
          date: r.date,
          title: r.title,
          word_count: r.word_count,
          todo_total: r.todo_total,
          todo_done: r.todo_done,
          revision: r.revision,
          tags: tagsMap.get(r.date) || [],
          projects: projectsMap.get(r.date) || [],
          updated_at: r.updated_at
        }))
      };
    },
    getResourceListSignature({ limit = 60 } = {}) {
      const safeLimit = Math.min(200, Math.max(1, Number(limit) || 60));
      const rows = adapter.all(
        `SELECT date, title, revision, todo_done, todo_total, updated_at
         FROM notes
         WHERE length(trim(content_md)) > 0
         ORDER BY date DESC
         LIMIT ?`,
        safeLimit
      );
      return rows.map((r) => `${r.date}|${r.title}|${r.revision}|${r.todo_done}/${r.todo_total}|${r.updated_at}`).join("\n");
    },
    saveAttachment(payload) {
      return saveAttachment(dbCtx, payload);
    },
    getAttachment(id) {
      return getAttachment(dbCtx, id);
    },
    cleanupOrphanedAttachments(opts) {
      return cleanupOrphanedAttachments(dbCtx, opts);
    }
  };
}

// sidecars/daily_notes/src/main.mjs
var __dirname = path5.dirname(fileURLToPath(import.meta.url));
var DEFAULT_DIST_DIR = path5.join(__dirname, "dist");
var MAX_JSON_BYTES = 2 * 1024 * 1024;
var MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
var STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
};
var TEXT_STATIC_EXTS = /* @__PURE__ */ new Set([".html", ".js", ".mjs", ".css", ".svg", ".json"]);
var StandaloneResponse = class {
  constructor(body, { status = 200, contentType = "text/plain; charset=utf-8", headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.contentType = contentType;
    this.headers = headers;
  }
};
function getMimeType(filePath) {
  const ext = path5.extname(filePath).toLowerCase();
  return STATIC_MIME[ext] || "application/octet-stream";
}
function walkDistFiles(distDir) {
  const files = [];
  if (!distDir || !fs3.existsSync(distDir)) return files;
  function visit(currentDir) {
    const entries = fs3.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path5.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const rel = path5.relative(distDir, fullPath).split(path5.sep).join("/");
        files.push({ rel, fullPath });
      }
    }
  }
  visit(distDir);
  return files;
}
function decodeBase64Payload(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new NotesError("INVALID_INPUT", "\u7F3A\u5C11\u56FE\u7247 base64 \u6570\u636E", 400);
  }
  const commaIdx = raw.indexOf(",");
  const base64Body = raw.startsWith("data:") && commaIdx >= 0 ? raw.slice(commaIdx + 1) : raw;
  const buf = Buffer.from(base64Body.trim(), "base64");
  if (buf.length === 0) {
    throw new NotesError("INVALID_ATTACHMENT", "\u56FE\u7247\u89E3\u7801\u540E\u4E3A\u7A7A", 400);
  }
  return buf;
}
function errorToResponse(ResponseClass, err) {
  if (err instanceof NotesError || err && typeof err.code === "string" && typeof err.status === "number") {
    const payload = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...err.details !== void 0 ? { details: err.details } : {}
      }
    };
    return new ResponseClass(JSON.stringify(payload), {
      status: err.status || 400,
      contentType: "application/json; charset=utf-8"
    });
  }
  console.error("[daily-notes sidecar] unexpected error:", err);
  return new ResponseClass(
    JSON.stringify({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: err?.message || "\u670D\u52A1\u5185\u90E8\u9519\u8BEF"
      }
    }),
    {
      status: 500,
      contentType: "application/json; charset=utf-8"
    }
  );
}
function createSidecarCore({
  dataDir,
  distDir = DEFAULT_DIST_DIR,
  mode = "standalone",
  ResponseClass = StandaloneResponse
} = {}) {
  const dbCtx = openDatabase({ dataDir });
  const service = createNotesService(dbCtx);
  try {
    service.cleanupOrphanedAttachments();
  } catch (err) {
    console.error("[daily-notes sidecar] startup orphan GC warning:", err?.message || err);
  }
  function wrapJson(fn, status = 200) {
    return (data = {}) => {
      try {
        const result = fn(data || {});
        if (status === 200) {
          return { ok: true, data: result };
        }
        return new ResponseClass(JSON.stringify({ ok: true, data: result }), {
          status,
          contentType: "application/json; charset=utf-8"
        });
      } catch (err) {
        return errorToResponse(ResponseClass, err);
      }
    };
  }
  const exactRoutes = {
    "GET /api/health": wrapJson(() => service.getHealth({ mode })),
    "GET /api/note": wrapJson((q) => service.getNote(q.date || getLocalDateString())),
    "GET /api/note/meta": wrapJson((q) => service.getNoteMeta(q.date || getLocalDateString())),
    "POST /api/note/save": wrapJson(
      (body) => service.saveNote(body.date || getLocalDateString(), {
        content_md: body.content_md,
        expected_revision: body.expected_revision,
        force: Boolean(body.force),
        editor: "user"
      })
    ),
    "POST /api/note/carry-over": wrapJson(
      (body) => service.carryOverTodos(body.date || getLocalDateString(), {
        action: body.action || "apply",
        source_date: body.source_date
      })
    ),
    "POST /api/note/projects/add": wrapJson(
      (body) => service.linkProject(body.date || getLocalDateString(), {
        workspace_uri: body.workspace_uri,
        workspace_name: body.workspace_name,
        linked_by: "user"
      })
    ),
    "POST /api/note/projects/remove": wrapJson(
      (body) => service.unlinkProject(body.date || getLocalDateString(), body.workspace_uri)
    ),
    "GET /api/calendar": wrapJson(
      (q) => service.getCalendar({
        month: q.month || getLocalDateString().slice(0, 7),
        tag: q.tag || "",
        workspace_uri: q.workspace_uri || ""
      })
    ),
    "GET /api/search": wrapJson(
      (q) => service.searchNotes({
        q: q.q || "",
        tag: q.tag || "",
        workspace_uri: q.workspace_uri || "",
        from: q.from || "",
        to: q.to || "",
        limit: q.limit,
        offset: q.offset
      })
    ),
    "GET /api/tags": wrapJson((q) => service.listTags({ q: q.q || "" })),
    "GET /api/projects": wrapJson(() => service.listAllProjects()),
    "GET /api/note/revisions": wrapJson(
      (q) => service.listRevisions(q.date || getLocalDateString(), { limit: q.limit })
    ),
    "POST /api/note/revisions/restore": wrapJson(
      (body) => service.restoreRevision(body.date || getLocalDateString(), body.id, {
        expected_revision: body.expected_revision
      })
    ),
    "POST /api/attachment/upload": wrapJson((body) => {
      const buffer = decodeBase64Payload(body.data_base64);
      return service.saveAttachment({
        buffer,
        origName: body.orig_name || "image.png",
        noteDate: body.note_date || null
      });
    }, 201),
    "GET /api/attachment": (q = {}) => {
      try {
        const item = service.getAttachment(q.id);
        return new ResponseClass(item.buffer, {
          status: 200,
          contentType: item.mime_type,
          headers: {
            "Cache-Control": "private, max-age=86400"
          }
        });
      } catch (err) {
        return errorToResponse(ResponseClass, err);
      }
    },
    "GET /api/note/export": (q = {}) => {
      try {
        const date = q.date || getLocalDateString();
        const frontmatter = q.frontmatter === "1" || q.frontmatter === "true" || q.frontmatter === true;
        const exported = service.exportNote(date, { frontmatter });
        return new ResponseClass(exported.markdown, {
          status: 200,
          contentType: "text/markdown; charset=utf-8",
          headers: {
            "Content-Disposition": `attachment; filename="${exported.filename}"`
          }
        });
      } catch (err) {
        return errorToResponse(ResponseClass, err);
      }
    }
  };
  return {
    dbCtx,
    service,
    distDir,
    exactRoutes,
    close() {
      dbCtx.close();
    }
  };
}
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new NotesError("PAYLOAD_TOO_LARGE", `\u8BF7\u6C42\u4F53\u8D85\u8FC7\u5927\u5C0F\u9650\u5236 (${maxBytes} bytes)`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
async function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  const buf = await readRawBody(req, maxBytes);
  const text = buf.toString("utf-8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new NotesError("INVALID_JSON", "JSON \u8BF7\u6C42\u4F53\u5FC5\u987B\u4E3A\u5BF9\u8C61", 400);
    }
    return parsed;
  } catch (err) {
    if (err instanceof NotesError) throw err;
    throw new NotesError("INVALID_JSON", "JSON \u8BF7\u6C42\u4F53\u89E3\u6790\u5931\u8D25", 400);
  }
}
function parseMultipartForm(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ""));
  if (!match) {
    throw new NotesError("INVALID_MULTIPART", "\u7F3A\u5C11 multipart boundary", 400);
  }
  const boundary = match[1] || match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");
  const fields = {};
  const files = {};
  let pos = buffer.indexOf(boundaryBuf);
  while (pos !== -1) {
    let partStart = pos + boundaryBuf.length;
    if (buffer.subarray(partStart, partStart + 2).equals(Buffer.from("--"))) {
      break;
    }
    if (buffer.subarray(partStart, partStart + 2).equals(Buffer.from("\r\n"))) {
      partStart += 2;
    }
    const nextBoundary = buffer.indexOf(boundaryBuf, partStart);
    if (nextBoundary === -1) break;
    let partEnd = nextBoundary;
    if (partEnd >= 2 && buffer[partEnd - 2] === 13 && buffer[partEnd - 1] === 10) {
      partEnd -= 2;
    }
    const headerEnd = buffer.indexOf(headerSep, partStart);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const headerText = buffer.subarray(partStart, headerEnd).toString("utf-8");
      const bodyBuf = buffer.subarray(headerEnd + 4, partEnd);
      const dispLine = headerText.split("\r\n").find((line) => line.toLowerCase().startsWith("content-disposition:"));
      if (dispLine) {
        const nameMatch = /\bname="([^"]+)"/i.exec(dispLine);
        const fileMatch = /\bfilename="([^"]*)"/i.exec(dispLine);
        const typeLine = headerText.split("\r\n").find((line) => line.toLowerCase().startsWith("content-type:"));
        const partContentType = typeLine ? typeLine.slice(typeLine.indexOf(":") + 1).trim() : "";
        if (nameMatch) {
          const fieldName = nameMatch[1];
          if (fileMatch) {
            files[fieldName] = {
              filename: fileMatch[1] || "upload.bin",
              contentType: partContentType,
              buffer: Buffer.from(bodyBuf)
            };
          } else {
            fields[fieldName] = bodyBuf.toString("utf-8");
          }
        }
      }
    }
    pos = nextBoundary;
  }
  return { fields, files };
}
function sendResult(res, result) {
  if (result instanceof StandaloneResponse) {
    const headers = {
      "Content-Type": result.contentType,
      ...result.headers
    };
    res.writeHead(result.status, headers);
    res.end(result.body);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result));
}
function parseQueryObject(urlObj) {
  const out = {};
  for (const [k, v] of urlObj.searchParams.entries()) {
    out[k] = v;
  }
  return out;
}
async function startStandaloneServer({
  port = Number(process.env.DAILY_NOTES_PORT || process.env.PORT || 4175),
  host = "127.0.0.1",
  dataDir,
  distDir = DEFAULT_DIST_DIR
} = {}) {
  const core = createSidecarCore({
    dataDir,
    distDir,
    mode: "standalone",
    ResponseClass: StandaloneResponse
  });
  const staticFiles = /* @__PURE__ */ new Map();
  for (const file of walkDistFiles(distDir)) {
    staticFiles.set(`/${file.rel}`, file.fullPath);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method || "GET").toUpperCase();
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const pathname = urlObj.pathname;
      const query = parseQueryObject(urlObj);
      const exactKey = `${method} ${pathname}`;
      const exactHandler = core.exactRoutes[exactKey];
      if (exactHandler) {
        if (method === "GET") {
          sendResult(res, exactHandler(query));
          return;
        }
        const maxBytes = pathname === "/api/attachment/upload" ? MAX_UPLOAD_BYTES : MAX_JSON_BYTES;
        const body = await readJsonBody(req, maxBytes);
        sendResult(res, exactHandler({ ...query, ...body }));
        return;
      }
      if (method === "GET" && pathname === "/preload.js") {
        sendResult(
          res,
          new StandaloneResponse("/* Daily Notes standalone preload stub */\n", {
            status: 200,
            contentType: "application/javascript; charset=utf-8"
          })
        );
        return;
      }
      let match;
      if (match = /^\/api\/notes\/([^/]+)$/.exec(pathname)) {
        const date = decodeURIComponent(match[1]);
        if (method === "GET") {
          sendResult(res, { ok: true, data: core.service.getNote(date) });
          return;
        }
        if (method === "PUT") {
          const body = await readJsonBody(req, MAX_JSON_BYTES);
          const data = core.service.saveNote(date, {
            content_md: body.content_md,
            expected_revision: body.expected_revision,
            force: Boolean(body.force),
            editor: "user"
          });
          sendResult(res, { ok: true, data });
          return;
        }
      }
      if (method === "GET" && (match = /^\/api\/notes\/([^/]+)\/meta$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        sendResult(res, { ok: true, data: core.service.getNoteMeta(date) });
        return;
      }
      if (method === "POST" && (match = /^\/api\/notes\/([^/]+)\/carry-over$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const data = core.service.carryOverTodos(date, {
          action: body.action || "apply",
          source_date: body.source_date
        });
        sendResult(res, { ok: true, data });
        return;
      }
      if (match = /^\/api\/notes\/([^/]+)\/projects$/.exec(pathname)) {
        const date = decodeURIComponent(match[1]);
        if (method === "POST") {
          const body = await readJsonBody(req, MAX_JSON_BYTES);
          const data = core.service.linkProject(date, {
            workspace_uri: body.workspace_uri,
            workspace_name: body.workspace_name,
            linked_by: "user"
          });
          sendResult(res, { ok: true, data });
          return;
        }
        if (method === "DELETE") {
          const wsUri = query.workspace_uri || "";
          const data = core.service.unlinkProject(date, wsUri);
          sendResult(res, { ok: true, data });
          return;
        }
      }
      if (method === "GET" && (match = /^\/api\/notes\/([^/]+)\/revisions$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const data = core.service.listRevisions(date, { limit: query.limit });
        sendResult(res, { ok: true, data });
        return;
      }
      if (method === "POST" && (match = /^\/api\/notes\/([^/]+)\/revisions\/([^/]+)\/restore$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const revId = decodeURIComponent(match[2]);
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const data = core.service.restoreRevision(date, revId, {
          expected_revision: body.expected_revision
        });
        sendResult(res, { ok: true, data });
        return;
      }
      if (method === "POST" && pathname === "/api/attachments") {
        const contentType = String(req.headers["content-type"] || "");
        if (contentType.toLowerCase().includes("multipart/form-data")) {
          const rawBuf = await readRawBody(req, MAX_UPLOAD_BYTES);
          const { fields, files } = parseMultipartForm(rawBuf, contentType);
          const filePart = files.file;
          if (!filePart) {
            throw new NotesError("INVALID_INPUT", "multipart \u8BF7\u6C42\u7F3A\u5C11 file \u5B57\u6BB5", 400);
          }
          const data2 = core.service.saveAttachment({
            buffer: filePart.buffer,
            origName: filePart.filename,
            noteDate: fields.note_date || null
          });
          sendResult(
            res,
            new StandaloneResponse(JSON.stringify({ ok: true, data: data2 }), {
              status: 201,
              contentType: "application/json; charset=utf-8"
            })
          );
          return;
        }
        const body = await readJsonBody(req, MAX_UPLOAD_BYTES);
        const buffer = decodeBase64Payload(body.data_base64);
        const data = core.service.saveAttachment({
          buffer,
          origName: body.orig_name || "image.png",
          noteDate: body.note_date || null
        });
        sendResult(
          res,
          new StandaloneResponse(JSON.stringify({ ok: true, data }), {
            status: 201,
            contentType: "application/json; charset=utf-8"
          })
        );
        return;
      }
      if (method === "GET" && (match = /^\/api\/attachments\/([^/]+)$/.exec(pathname))) {
        const id = decodeURIComponent(match[1]);
        const item = core.service.getAttachment(id);
        sendResult(
          res,
          new StandaloneResponse(item.buffer, {
            status: 200,
            contentType: item.mime_type,
            headers: { "Cache-Control": "private, max-age=86400" }
          })
        );
        return;
      }
      if (method === "GET" && (match = /^\/api\/notes\/([^/]+)\/export$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const frontmatter = query.frontmatter === "1" || query.frontmatter === "true";
        const exported = core.service.exportNote(date, { frontmatter });
        sendResult(
          res,
          new StandaloneResponse(exported.markdown, {
            status: 200,
            contentType: "text/markdown; charset=utf-8",
            headers: {
              "Content-Disposition": `attachment; filename="${exported.filename}"`
            }
          })
        );
        return;
      }
      if (method === "GET") {
        const lookupPath = pathname === "/" ? "/index.html" : pathname;
        const targetFile = staticFiles.get(lookupPath);
        if (targetFile && fs3.existsSync(targetFile)) {
          sendResult(
            res,
            new StandaloneResponse(fs3.readFileSync(targetFile), {
              status: 200,
              contentType: getMimeType(targetFile)
            })
          );
          return;
        }
      }
      sendResult(
        res,
        new StandaloneResponse(
          JSON.stringify({
            ok: false,
            error: { code: "NOT_FOUND", message: `Route not found: ${method} ${pathname}` }
          }),
          { status: 404, contentType: "application/json; charset=utf-8" }
        )
      );
    } catch (err) {
      sendResult(res, errorToResponse(StandaloneResponse, err));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    core,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      core.close();
    }
  };
}
async function runMain() {
  let sdk = null;
  try {
    sdk = await import("sidecar_sdk");
  } catch (err) {
    if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
      console.error("[daily-notes sidecar] sidecar_sdk import failed:", err?.message || err);
    }
    sdk = null;
  }
  if (sdk?.SidecarApp && sdk?.Response) {
    const { SidecarApp, Response } = sdk;
    const core = createSidecarCore({
      distDir: DEFAULT_DIST_DIR,
      mode: "sidecar_sdk",
      ResponseClass: Response
    });
    const app = new SidecarApp();
    const indexPath = path5.join(DEFAULT_DIST_DIR, "index.html");
    app.page("/", () => {
      if (!fs3.existsSync(indexPath)) {
        return "<!doctype html><html><body><p>Daily Notes frontend has not been built yet.</p></body></html>";
      }
      return fs3.readFileSync(indexPath, "utf-8");
    });
    for (const file of walkDistFiles(DEFAULT_DIST_DIR)) {
      if (file.rel === "index.html") continue;
      const ext = path5.extname(file.fullPath).toLowerCase();
      const mime = getMimeType(file.fullPath);
      const isText = TEXT_STATIC_EXTS.has(ext);
      app.api(
        `/${file.rel}`,
        () => new Response(
          isText ? fs3.readFileSync(file.fullPath, "utf-8") : fs3.readFileSync(file.fullPath),
          { contentType: mime }
        ),
        "GET"
      );
    }
    for (const [key, handler] of Object.entries(core.exactRoutes)) {
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const routePath = key.slice(spaceIdx + 1);
      app.api(routePath, handler, method);
    }
    const shutdown2 = () => {
      try {
        core.close();
      } catch {
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown2);
    process.on("SIGTERM", shutdown2);
    await app.run();
    return;
  }
  const instance = await startStandaloneServer();
  console.error(`[daily-notes sidecar] standalone server listening at ${instance.baseUrl} (data: ${instance.core.dbCtx.dataDir})`);
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return fs3.realpathSync(process.argv[1]) === fs3.realpathSync(selfPath);
  } catch {
    return path5.resolve(process.argv[1]) === path5.resolve(selfPath);
  }
}
if (isExecutedDirectly()) {
  runMain().catch((err) => {
    console.error("[daily-notes sidecar] fatal startup error:", err);
    process.exit(1);
  });
}
export {
  StandaloneResponse,
  createSidecarCore,
  startStandaloneServer
};
