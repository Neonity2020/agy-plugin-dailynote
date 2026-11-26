import path from 'node:path';
import {
  daysBetween,
  getLocalDateString,
  isValidDateString,
  isValidMonthString,
  monthDateBounds,
  nowIso,
  shiftDateString,
} from './config.mjs';
import {
  buildCarryOverSection,
  buildShortSnippet,
  escapeLike,
  extractMetadata,
  formatExportMarkdown,
  normalizeLineEndings,
  appendMarkdown,
  replaceSectionMarkdown,
  toggleTodoLine,
} from './markdown.mjs';
import {
  cleanupOrphanedAttachments,
  getAttachment,
  saveAttachment,
  syncNoteAttachments,
} from './attachments.mjs';

const MAX_REVISIONS_PER_NOTE = 50;
const CARRYOVER_LOOKBACK_DAYS = 30;
const MAX_RANGE_DAYS = 90;

const MARK_OPEN_TOKEN = '__DN_MARK_START_9F2A__';
const MARK_CLOSE_TOKEN = '__DN_MARK_END_9F2A__';

export class NotesError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'NotesError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFtsSnippet(rawSnippet) {
  return escapeHtml(rawSnippet)
    .replaceAll(MARK_OPEN_TOKEN, '<mark>')
    .replaceAll(MARK_CLOSE_TOKEN, '</mark>');
}

function assertValidDate(dateStr) {
  if (!isValidDateString(dateStr)) {
    throw new NotesError('INVALID_DATE', `日期格式非法: ${dateStr}，要求为合法 YYYY-MM-DD`, 400);
  }
}

function assertValidMonth(monthStr) {
  if (!isValidMonthString(monthStr)) {
    throw new NotesError('INVALID_MONTH', `月份格式非法: ${monthStr}，要求为 YYYY-MM`, 400);
  }
}

function defaultWorkspaceName(workspaceUri, workspaceName) {
  if (typeof workspaceName === 'string' && workspaceName.trim()) {
    return workspaceName.trim();
  }
  const clean = String(workspaceUri || '').replace(/\/+$/, '');
  const base = path.posix.basename(clean.replace(/\\/g, '/'));
  return base || clean || 'workspace';
}

function getTagsForDate(tx, date) {
  return tx
    .all('SELECT tag FROM note_tags WHERE note_date = ? ORDER BY tag ASC', date)
    .map((r) => r.tag);
}

function getProjectsForDate(tx, date) {
  return tx.all(
    `SELECT workspace_uri, workspace_name, linked_by, created_at
     FROM note_projects
     WHERE note_date = ?
     ORDER BY created_at ASC`,
    date,
  );
}

function getBacklinksForDate(tx, date) {
  return tx.all(
    `SELECT l.source_date AS date, n.title AS title, n.updated_at AS updated_at
     FROM note_links l
     JOIN notes n ON n.date = l.source_date
     WHERE l.target_date = ? AND length(trim(n.content_md)) > 0
     ORDER BY l.source_date DESC`,
    date,
  );
}

function getTagsBatch(tx, dates) {
  const map = new Map();
  if (!dates.length) return map;
  const placeholders = dates.map(() => '?').join(',');
  const rows = tx.all(
    `SELECT note_date, tag FROM note_tags WHERE note_date IN (${placeholders}) ORDER BY tag ASC`,
    ...dates,
  );
  for (const row of rows) {
    if (!map.has(row.note_date)) map.set(row.note_date, []);
    map.get(row.note_date).push(row.tag);
  }
  return map;
}

function getProjectsBatch(tx, dates) {
  const map = new Map();
  if (!dates.length) return map;
  const placeholders = dates.map(() => '?').join(',');
  const rows = tx.all(
    `SELECT note_date, workspace_uri, workspace_name, linked_by, created_at
     FROM note_projects
     WHERE note_date IN (${placeholders})
     ORDER BY created_at ASC`,
    ...dates,
  );
  for (const row of rows) {
    if (!map.has(row.note_date)) map.set(row.note_date, []);
    map.get(row.note_date).push({
      workspace_uri: row.workspace_uri,
      workspace_name: row.workspace_name,
      linked_by: row.linked_by,
      created_at: row.created_at,
    });
  }
  return map;
}

function computeYesterdayPending(tx, targetDate, noteRow) {
  const today = getLocalDateString();
  if (targetDate !== today) return null;
  if (noteRow && (noteRow.content_md.trim() !== '' || noteRow.carry_over_from || noteRow.carry_over_dismissed === 1)) {
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
    minSourceDate,
  );
  if (!candidate) return null;

  const sourceMeta = extractMetadata(candidate.content_md);
  const openItems = sourceMeta.todos.filter((t) => !t.completed);
  if (!openItems.length) return null;

  const carriedRows = tx.all(
    'SELECT item_hash FROM todo_carryovers WHERE target_date = ? AND source_date = ?',
    targetDate,
    candidate.date,
  );
  const carriedSet = new Set(carriedRows.map((r) => r.item_hash));
  const pending = openItems.filter((item) => !carriedSet.has(item.hash));
  if (!pending.length) return null;

  return {
    source_date: candidate.date,
    count: pending.length,
    items: pending.map((item) => ({ text: item.text, hash: item.hash })),
  };
}

function readFullNote(tx, date) {
  const row = tx.get('SELECT * FROM notes WHERE date = ?', date);
  const backlinks = getBacklinksForDate(tx, date);
  if (!row) {
    return {
      date,
      exists: false,
      title: '',
      content_md: '',
      plain_text: '',
      word_count: 0,
      todo_total: 0,
      todo_done: 0,
      revision: 0,
      last_editor: 'user',
      carry_over_from: null,
      carry_over_dismissed: 0,
      created_at: null,
      updated_at: null,
      last_agent_at: null,
      tags: [],
      projects: [],
      backlinks,
      yesterday_pending: computeYesterdayPending(tx, date, null),
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
    yesterday_pending: computeYesterdayPending(tx, date, row),
  };
}

function insertRevisionSnapshot(tx, { noteDate, revision, contentMd, source, summary = '', createdAt = nowIso() }) {
  const info = tx.run(
    `INSERT INTO note_revisions (note_date, revision, content_md, source, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    noteDate,
    revision,
    contentMd,
    source,
    summary,
    createdAt,
  );
  const snapshotId = Number(info.lastInsertRowid);

  // Retain at most MAX_REVISIONS_PER_NOTE latest snapshots for this date
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
    MAX_REVISIONS_PER_NOTE,
  );

  return snapshotId;
}

function rebuildDerivedIndices(tx, noteDate, meta, now) {
  tx.run('DELETE FROM note_tags WHERE note_date = ?', noteDate);
  for (const tag of meta.tags) {
    tx.run('INSERT INTO note_tags (note_date, tag) VALUES (?, ?)', noteDate, tag);
  }

  tx.run('DELETE FROM note_links WHERE source_date = ?', noteDate);
  for (const targetDate of meta.links) {
    tx.run('INSERT INTO note_links (source_date, target_date) VALUES (?, ?)', noteDate, targetDate);
  }

  syncNoteAttachments(tx, noteDate, meta.attachment_ids, now);
}

function writeNoteContent(tx, {
  date,
  nextMd,
  editor = 'user',
  existingRow = null,
  now = nowIso(),
  carryOverFrom = undefined,
  carryOverDismissed = undefined,
}) {
  const normalized = normalizeLineEndings(nextMd);
  const meta = extractMetadata(normalized);

  if (!existingRow) {
    const lastAgentAt = editor === 'agent' ? now : null;
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
      lastAgentAt,
    );
  } else {
    const nextRevision = existingRow.revision + 1;
    const nextLastAgentAt = editor === 'agent' ? now : existingRow.last_agent_at;
    const nextCarryOverFrom = carryOverFrom !== undefined ? carryOverFrom : existingRow.carry_over_from;
    const nextCarryOverDismissed =
      carryOverDismissed !== undefined ? carryOverDismissed : existingRow.carry_over_dismissed;

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
      date,
    );
  }

  rebuildDerivedIndices(tx, date, meta, now);
}

/**
 * Create the high-level Daily Notes service bound to an open database context.
 */
export function createNotesService(dbCtx) {
  const { adapter } = dbCtx;

  return {
    getHealth({ mode = 'standalone' } = {}) {
      return {
        status: 'ok',
        data_dir: dbCtx.dataDir,
        db_path: dbCtx.dbPath,
        schema_version: dbCtx.schemaVersion,
        mode,
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
        date,
      );
      if (!row) {
        return {
          date,
          exists: false,
          revision: 0,
          updated_at: null,
          last_editor: 'user',
          last_agent_at: null,
          todo_total: 0,
          todo_done: 0,
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
        todo_done: row.todo_done,
      };
    },

    saveNote(date, {
      content_md,
      expected_revision,
      force = false,
      editor = 'user',
      checkpoint_source = null,
      checkpoint_summary = '',
    } = {}) {
      assertValidDate(date);
      if (typeof content_md !== 'string') {
        throw new NotesError('INVALID_INPUT', 'content_md 必须为字符串', 400);
      }

      return adapter.transaction((tx) => {
        const existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
        const currentRevision = existing ? existing.revision : 0;
        const normalized = normalizeLineEndings(content_md);

        // Enforce optimistic locking when expected_revision is provided and force is false
        if (!force && expected_revision !== undefined && expected_revision !== null) {
          const expectedNum = Number(expected_revision);
          if (!Number.isInteger(expectedNum) || expectedNum < 0) {
            throw new NotesError('INVALID_REVISION', 'expected_revision 必须是非负整数', 400);
          }
          if (expectedNum !== currentRevision) {
            throw new NotesError(
              'REVISION_CONFLICT',
              `版本冲突：期望 rev ${expectedNum}，当前服务端为 rev ${currentRevision}`,
              409,
              {
                expected_revision: expectedNum,
                current_revision: currentRevision,
                server_note: readFullNote(tx, date),
              },
            );
          }
        }

        // Lazy creation: do not insert redundant empty row if note doesn't exist yet and text is empty
        if (!existing && normalized.trim() === '' && !checkpoint_source) {
          return readFullNote(tx, date);
        }

        const now = nowIso();
        // Backup overwritten content on forced override or explicit checkpoint
        if (existing && force && expected_revision != null && Number(expected_revision) !== currentRevision) {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: 'restore_backup',
            summary: '冲突时被本地强制覆盖前备份',
            createdAt: now,
          });
        } else if (existing && checkpoint_source) {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: checkpoint_source,
            summary: checkpoint_summary,
            createdAt: now,
          });
        }

        writeNoteContent(tx, {
          date,
          nextMd: normalized,
          editor,
          existingRow: existing,
          now,
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
      summary = '',
    } = {}) {
      assertValidDate(date);
      if (typeof markdown !== 'string' || markdown.trim() === '') {
        throw new NotesError('INVALID_INPUT', 'markdown 不能为空', 400);
      }

      return adapter.transaction((tx) => {
        const now = nowIso();
        let existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
        let snapshotId = null;

        if (!existing) {
          // Insert revision=0 empty anchor row first so note_revisions FK succeeds and undo can restore to empty
          tx.run(
            `INSERT INTO notes (
               date, title, content_md, plain_text, word_count, todo_total, todo_done,
               revision, last_editor, carry_over_from, carry_over_dismissed,
               created_at, updated_at, last_agent_at
             ) VALUES (?, '', '', '', 0, 0, 0, 0, 'agent', NULL, 0, ?, ?, ?)`,
            date,
            now,
            now,
            now,
          );
          existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
          snapshotId = insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: 0,
            contentMd: '',
            source: 'agent',
            summary: summary || 'Agent 写入新笔记前空快照',
            createdAt: now,
          });
        } else {
          snapshotId = insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: 'agent',
            summary: summary || 'Agent 追加内容前快照',
            createdAt: now,
          });
        }

        const nextMd = appendMarkdown(existing.content_md, markdown, heading);
        writeNoteContent(tx, {
          date,
          nextMd,
          editor: 'agent',
          existingRow: existing,
          now,
        });

        if (typeof workspace_uri === 'string' && workspace_uri.trim()) {
          const cleanUri = workspace_uri.trim();
          const wsName = defaultWorkspaceName(cleanUri, workspace_name);
          tx.run(
            `INSERT INTO note_projects (note_date, workspace_uri, workspace_name, linked_by, created_at)
             VALUES (?, ?, ?, 'agent', ?)
             ON CONFLICT(note_date, workspace_uri) DO UPDATE SET workspace_name = excluded.workspace_name`,
            date,
            cleanUri,
            wsName,
            now,
          );
        }

        return {
          note: readFullNote(tx, date),
          snapshot_id: snapshotId,
        };
      });
    },

    toggleTodo({
      date = getLocalDateString(),
      expected_revision,
      line_number,
      match_text,
      completed,
      editor = 'agent',
      summary = '',
    } = {}) {
      assertValidDate(date);
      if (expected_revision === undefined || expected_revision === null || !Number.isInteger(Number(expected_revision))) {
        throw new NotesError('INVALID_REVISION', '必须提供整数 expected_revision', 400);
      }
      if (typeof completed !== 'boolean') {
        throw new NotesError('INVALID_INPUT', 'completed 必须为布尔值', 400);
      }

      const expectedRev = Number(expected_revision);

      return adapter.transaction((tx) => {
        const existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
        const currentRev = existing ? existing.revision : 0;

        if (expectedRev !== currentRev) {
          throw new NotesError(
            'REVISION_CONFLICT',
            `版本冲突：期望 rev ${expectedRev}，当前服务端为 rev ${currentRev}`,
            409,
            {
              expected_revision: expectedRev,
              current_revision: currentRev,
              server_note: readFullNote(tx, date),
            },
          );
        }

        if (!existing) {
          throw new NotesError('NOTE_NOT_FOUND', `${date} 暂无笔记内容`, 404);
        }

        const toggled = toggleTodoLine(existing.content_md, {
          lineNumber: line_number != null ? Number(line_number) : undefined,
          matchText: match_text,
          completed,
        });

        if (!toggled.ok) {
          const status = toggled.errorCode === 'TODO_NOT_FOUND' ? 404 : toggled.errorCode === 'INVALID_INPUT' ? 400 : 409;
          throw new NotesError(
            toggled.errorCode,
            toggled.message,
            status,
            toggled.candidates ? { candidates: toggled.candidates } : undefined,
          );
        }

        if (!toggled.changed) {
          return {
            note: readFullNote(tx, date),
            changed: false,
            line_number: toggled.line_number,
            text: toggled.text,
            completed: toggled.completed,
            snapshot_id: null,
          };
        }

        const now = nowIso();
        const snapshotId = insertRevisionSnapshot(tx, {
          noteDate: date,
          revision: existing.revision,
          contentMd: existing.content_md,
          source: editor === 'agent' ? 'agent' : 'manual_checkpoint',
          summary: summary || `切换待办状态: ${toggled.text.slice(0, 60)}`,
          createdAt: now,
        });

        writeNoteContent(tx, {
          date,
          nextMd: toggled.content_md,
          editor,
          existingRow: existing,
          now,
        });

        return {
          note: readFullNote(tx, date),
          changed: true,
          line_number: toggled.line_number,
          text: toggled.text,
          completed: toggled.completed,
          snapshot_id: snapshotId,
        };
      });
    },

    updateNoteControlled({
      date = getLocalDateString(),
      expected_revision,
      mode,
      heading,
      markdown,
      summary,
    } = {}) {
      assertValidDate(date);
      if (expected_revision === undefined || expected_revision === null || !Number.isInteger(Number(expected_revision))) {
        throw new NotesError('INVALID_REVISION', '必须提供整数 expected_revision', 400);
      }
      if (mode !== 'replace' && mode !== 'replace_section') {
        throw new NotesError('INVALID_INPUT', 'mode 必须为 replace 或 replace_section', 400);
      }
      if (mode === 'replace_section' && (typeof heading !== 'string' || !heading.trim())) {
        throw new NotesError('INVALID_INPUT', 'mode 为 replace_section 时必须提供 heading', 400);
      }
      if (typeof markdown !== 'string') {
        throw new NotesError('INVALID_INPUT', 'markdown 必须为字符串', 400);
      }
      if (typeof summary !== 'string' || !summary.trim()) {
        throw new NotesError('INVALID_INPUT', '必须提供非空 summary 说明修改意图', 400);
      }

      const expectedRev = Number(expected_revision);

      return adapter.transaction((tx) => {
        const now = nowIso();
        let existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
        const currentRev = existing ? existing.revision : 0;

        if (expectedRev !== currentRev) {
          throw new NotesError(
            'REVISION_CONFLICT',
            `版本冲突：期望 rev ${expectedRev}，当前服务端为 rev ${currentRev}`,
            409,
            {
              expected_revision: expectedRev,
              current_revision: currentRev,
              server_note: readFullNote(tx, date),
            },
          );
        }

        let nextMd;
        if (mode === 'replace') {
          nextMd = normalizeLineEndings(markdown);
        } else {
          if (!existing) {
            throw new NotesError('HEADING_NOT_FOUND', `${date} 尚未创建笔记，找不到小节 "${heading}"`, 404);
          }
          const replaced = replaceSectionMarkdown(existing.content_md, heading, markdown);
          if (!replaced.found) {
            throw new NotesError('HEADING_NOT_FOUND', `未找到标题为 "${heading}" 的小节`, 404);
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
            now,
          );
          existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
        }

        const snapshotId = insertRevisionSnapshot(tx, {
          noteDate: date,
          revision: existing.revision,
          contentMd: existing.content_md,
          source: 'agent',
          summary: summary.trim(),
          createdAt: now,
        });

        writeNoteContent(tx, {
          date,
          nextMd,
          editor: 'agent',
          existingRow: existing,
          now,
        });

        return {
          note: readFullNote(tx, date),
          snapshot_id: snapshotId,
        };
      });
    },

    carryOverTodos(date, { action = 'apply', source_date } = {}) {
      assertValidDate(date);
      if (action !== 'apply' && action !== 'dismiss') {
        throw new NotesError('INVALID_INPUT', 'action 必须为 apply 或 dismiss', 400);
      }
      if (source_date != null) {
        assertValidDate(source_date);
      }

      return adapter.transaction((tx) => {
        const now = nowIso();
        const existing = tx.get('SELECT * FROM notes WHERE date = ?', date);

        if (action === 'dismiss') {
          if (!existing) {
            tx.run(
              `INSERT INTO notes (
                 date, title, content_md, plain_text, word_count, todo_total, todo_done,
                 revision, last_editor, carry_over_from, carry_over_dismissed,
                 created_at, updated_at, last_agent_at
               ) VALUES (?, '', '', '', 0, 0, 0, 1, 'user', NULL, 1, ?, ?, NULL)`,
              date,
              now,
              now,
            );
          } else {
            tx.run(
              'UPDATE notes SET carry_over_dismissed = 1, updated_at = ? WHERE date = ?',
              now,
              date,
            );
          }
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: 0,
          };
        }

        let sourceRow = null;
        if (source_date) {
          sourceRow = tx.get('SELECT date, content_md FROM notes WHERE date = ?', source_date);
        } else {
          const minDate = shiftDateString(date, -CARRYOVER_LOOKBACK_DAYS);
          sourceRow = tx.get(
            `SELECT date, content_md
             FROM notes
             WHERE date < ? AND date >= ? AND todo_total > todo_done AND length(trim(content_md)) > 0
             ORDER BY date DESC
             LIMIT 1`,
            date,
            minDate,
          );
        }

        if (!sourceRow) {
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: 0,
          };
        }

        const sourceMeta = extractMetadata(sourceRow.content_md);
        const openItems = sourceMeta.todos.filter((t) => !t.completed);
        if (!openItems.length) {
          return {
            note: readFullNote(tx, date),
            carried_count: 0,
            skipped_count: 0,
          };
        }

        const carriedRows = tx.all(
          'SELECT item_hash FROM todo_carryovers WHERE target_date = ? AND source_date = ?',
          date,
          sourceRow.date,
        );
        const carriedSet = new Set(carriedRows.map((r) => r.item_hash));

        // Deduplicate identical hashes within the same source note as well
        const toCarry = [];
        const seenInBatch = new Set();
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
            skipped_count: skippedCount,
          };
        }

        if (existing && existing.content_md.trim() !== '') {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: 'carry_over_backup',
            summary: `顺延来自 ${sourceRow.date} 的 ${toCarry.length} 项待办前备份`,
            createdAt: now,
          });
        }

        const nextMd = buildCarryOverSection(existing ? existing.content_md : '', sourceRow.date, toCarry);
        writeNoteContent(tx, {
          date,
          nextMd,
          editor: existing ? existing.last_editor : 'system',
          existingRow: existing,
          now,
          carryOverFrom: existing?.carry_over_from || sourceRow.date,
          carryOverDismissed: 0,
        });

        for (const item of toCarry) {
          tx.run(
            `INSERT OR IGNORE INTO todo_carryovers (target_date, source_date, item_hash, carried_at)
             VALUES (?, ?, ?, ?)`,
            date,
            sourceRow.date,
            item.hash,
            now,
          );
        }

        return {
          note: readFullNote(tx, date),
          carried_count: toCarry.length,
          skipped_count: skippedCount,
        };
      });
    },

    linkProject(date, { workspace_uri, workspace_name, linked_by = 'user' } = {}) {
      assertValidDate(date);
      if (typeof workspace_uri !== 'string' || !workspace_uri.trim()) {
        throw new NotesError('INVALID_INPUT', 'workspace_uri 不能为空', 400);
      }
      const cleanUri = workspace_uri.trim();
      const wsName = defaultWorkspaceName(cleanUri, workspace_name);
      const role = linked_by === 'agent' ? 'agent' : 'user';

      return adapter.transaction((tx) => {
        const now = nowIso();
        const existing = tx.get('SELECT date FROM notes WHERE date = ?', date);
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
            now,
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
          now,
        );

        return {
          projects: getProjectsForDate(tx, date),
        };
      });
    },

    unlinkProject(date, workspaceUri) {
      assertValidDate(date);
      if (typeof workspaceUri !== 'string' || !workspaceUri.trim()) {
        throw new NotesError('INVALID_INPUT', 'workspace_uri 不能为空', 400);
      }
      return adapter.transaction((tx) => {
        tx.run(
          'DELETE FROM note_projects WHERE note_date = ? AND workspace_uri = ?',
          date,
          workspaceUri.trim(),
        );
        return {
          projects: getProjectsForDate(tx, date),
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
           ORDER BY count DESC, workspace_name ASC`,
        ),
      };
    },

    getCalendar({ month, tag = '', workspace_uri = '' } = {}) {
      assertValidMonth(month);
      const { startDate, endDate } = monthDateBounds(month);
      const cleanTag = String(tag || '').trim().replace(/^#/, '').toLowerCase();
      const cleanWs = String(workspace_uri || '').trim();

      const whereClauses = [
        'n.date >= ?',
        'n.date <= ?',
        'length(trim(n.content_md)) > 0',
      ];
      const params = [startDate, endDate];

      if (cleanTag) {
        whereClauses.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)');
        params.push(cleanTag);
      }
      if (cleanWs) {
        whereClauses.push(
          'EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)',
        );
        params.push(cleanWs);
      }

      const rows = adapter.all(
        `SELECT n.date, n.todo_total, n.todo_done
         FROM notes n
         WHERE ${whereClauses.join(' AND ')}`,
        ...params,
      );

      const byDate = new Map(rows.map((r) => [r.date, r]));
      const totalDays = Number(endDate.slice(-2));
      const days = [];
      for (let d = 1; d <= totalDays; d++) {
        const dateStr = `${month}-${String(d).padStart(2, '0')}`;
        const hit = byDate.get(dateStr);
        days.push({
          date: dateStr,
          has_note: Boolean(hit),
          todo_total: hit ? hit.todo_total : 0,
          todo_done: hit ? hit.todo_done : 0,
        });
      }

      return { month, days };
    },

    searchNotes({
      q = '',
      tag = '',
      workspace_uri = '',
      from = '',
      to = '',
      limit = 30,
      offset = 0,
    } = {}) {
      const cleanQuery = String(q || '').trim();
      const cleanTag = String(tag || '').trim().replace(/^#/, '').toLowerCase();
      const cleanWs = String(workspace_uri || '').trim();
      const cleanFrom = String(from || '').trim();
      const cleanTo = String(to || '').trim();

      if (cleanFrom) assertValidDate(cleanFrom);
      if (cleanTo) assertValidDate(cleanTo);

      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
      const safeOffset = Math.max(0, Number(offset) || 0);

      const filterClauses = ['length(trim(n.content_md)) > 0'];
      const filterParams = [];

      if (cleanTag) {
        filterClauses.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)');
        filterParams.push(cleanTag);
      }
      if (cleanWs) {
        filterClauses.push(
          'EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)',
        );
        filterParams.push(cleanWs);
      }
      if (cleanFrom) {
        filterClauses.push('n.date >= ?');
        filterParams.push(cleanFrom);
      }
      if (cleanTo) {
        filterClauses.push('n.date <= ?');
        filterParams.push(cleanTo);
      }

      let total = 0;
      let rows = [];

      if (cleanQuery.length >= 3) {
        // Path 1: FTS5 trigram full-text match
        const ftsQuery = `"${cleanQuery.replace(/"/g, '""')}"`;
        const whereSql = ['notes_fts MATCH ?', ...filterClauses].join(' AND ');
        const countRow = adapter.get(
          `SELECT COUNT(*) AS cnt
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE ${whereSql}`,
          ftsQuery,
          ...filterParams,
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
          safeOffset,
        );
      } else if (cleanQuery.length > 0) {
        // Path 2: 1-2 char LIKE substring fallback
        const likePattern = `%${escapeLike(cleanQuery)}%`;
        const whereSql = [
          "(n.plain_text LIKE ? ESCAPE '\\' OR n.content_md LIKE ? ESCAPE '\\')",
          ...filterClauses,
        ].join(' AND ');

        const countRow = adapter.get(
          `SELECT COUNT(*) AS cnt FROM notes n WHERE ${whereSql}`,
          likePattern,
          likePattern,
          ...filterParams,
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
          safeOffset,
        );
      } else {
        // Path 3: Pure tag / project / date-range query
        const whereSql = filterClauses.join(' AND ');
        const countRow = adapter.get(
          `SELECT COUNT(*) AS cnt FROM notes n WHERE ${whereSql}`,
          ...filterParams,
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
          safeOffset,
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
          updated_at: r.updated_at,
        };
      });

      return { total, items };
    },

    listRange({
      start_date,
      end_date,
      tag = '',
      workspace_uri = '',
      include_content = false,
    } = {}) {
      assertValidDate(start_date);
      assertValidDate(end_date);
      const span = daysBetween(start_date, end_date);
      if (span < 0) {
        throw new NotesError('INVALID_RANGE', 'start_date 不能晚于 end_date', 400);
      }
      if (span > MAX_RANGE_DAYS) {
        throw new NotesError('RANGE_TOO_LARGE', `单次查询跨度不能超过 ${MAX_RANGE_DAYS} 天`, 400);
      }

      const cleanTag = String(tag || '').trim().replace(/^#/, '').toLowerCase();
      const cleanWs = String(workspace_uri || '').trim();
      const clauses = [
        'n.date >= ?',
        'n.date <= ?',
        'length(trim(n.content_md)) > 0',
      ];
      const params = [start_date, end_date];

      if (cleanTag) {
        clauses.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)');
        params.push(cleanTag);
      }
      if (cleanWs) {
        clauses.push(
          'EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)',
        );
        params.push(cleanWs);
      }

      const rows = adapter.all(
        `SELECT n.date, n.title, n.plain_text, n.content_md, n.word_count,
                n.todo_total, n.todo_done, n.revision, n.updated_at
         FROM notes n
         WHERE ${clauses.join(' AND ')}
         ORDER BY n.date DESC`,
        ...params,
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
            preview: r.plain_text.length > 160 ? `${r.plain_text.slice(0, 160)}…` : r.plain_text,
            word_count: r.word_count,
            todo_total: r.todo_total,
            todo_done: r.todo_done,
            revision: r.revision,
            tags: tagsMap.get(r.date) || [],
            projects: projectsMap.get(r.date) || [],
            updated_at: r.updated_at,
          };
          if (include_content) {
            item.content_md = r.content_md;
          }
          return item;
        }),
      };
    },

    getOpenTodos({ days = 7, start_date, end_date, workspace_uri = '' } = {}) {
      const today = getLocalDateString();
      const resolvedEnd = end_date || today;
      assertValidDate(resolvedEnd);
      const safeDays = Math.min(MAX_RANGE_DAYS, Math.max(1, Number(days) || 7));
      const resolvedStart = start_date || shiftDateString(resolvedEnd, -(safeDays - 1));
      assertValidDate(resolvedStart);

      const span = daysBetween(resolvedStart, resolvedEnd);
      if (span < 0) {
        throw new NotesError('INVALID_RANGE', 'start_date 不能晚于 end_date', 400);
      }
      if (span > MAX_RANGE_DAYS) {
        throw new NotesError('RANGE_TOO_LARGE', `单次待办扫描跨度不能超过 ${MAX_RANGE_DAYS} 天`, 400);
      }

      const cleanWs = String(workspace_uri || '').trim();
      const clauses = [
        'n.date >= ?',
        'n.date <= ?',
        'n.todo_total > n.todo_done',
        'length(trim(n.content_md)) > 0',
      ];
      const params = [resolvedStart, resolvedEnd];
      if (cleanWs) {
        clauses.push(
          'EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)',
        );
        params.push(cleanWs);
      }

      const rows = adapter.all(
        `SELECT n.date, n.revision, n.content_md
         FROM notes n
         WHERE ${clauses.join(' AND ')}
         ORDER BY n.date DESC`,
        ...params,
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
              text: todo.text,
            });
          }
        }
      }

      return {
        start_date: resolvedStart,
        end_date: resolvedEnd,
        total_open: items.length,
        items,
      };
    },

    listTags({ q = '' } = {}) {
      const prefix = String(q || '').trim().replace(/^#/, '').toLowerCase();
      const clauses = ['length(trim(n.content_md)) > 0'];
      const params = [];
      if (prefix) {
        clauses.push("t.tag LIKE ? ESCAPE '\\'");
        params.push(`${escapeLike(prefix)}%`);
      }

      const tags = adapter.all(
        `SELECT t.tag, COUNT(*) AS count
         FROM note_tags t
         JOIN notes n ON n.date = t.note_date
         WHERE ${clauses.join(' AND ')}
         GROUP BY t.tag
         ORDER BY count DESC, t.tag ASC`,
        ...params,
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
        safeLimit,
      );

      return {
        revisions: rows.map((r) => ({
          id: r.id,
          revision: r.revision,
          source: r.source,
          summary: r.summary,
          created_at: r.created_at,
          content_md: r.content_md,
          preview: r.content_md.length > 200 ? `${r.content_md.slice(0, 200)}…` : r.content_md,
        })),
      };
    },

    restoreRevision(date, revisionId, { expected_revision } = {}) {
      assertValidDate(date);
      const idNum = Number(revisionId);
      if (!Number.isInteger(idNum) || idNum <= 0) {
        throw new NotesError('INVALID_INPUT', '快照 ID 非法', 400);
      }

      return adapter.transaction((tx) => {
        const targetRev = tx.get(
          'SELECT * FROM note_revisions WHERE id = ? AND note_date = ?',
          idNum,
          date,
        );
        if (!targetRev) {
          throw new NotesError('REVISION_NOT_FOUND', `未找到快照 #${idNum}`, 404);
        }

        const existing = tx.get('SELECT * FROM notes WHERE date = ?', date);
        const currentRev = existing ? existing.revision : 0;

        if (expected_revision !== undefined && expected_revision !== null) {
          const expectedNum = Number(expected_revision);
          if (expectedNum !== currentRev) {
            throw new NotesError(
              'REVISION_CONFLICT',
              `版本冲突：期望 rev ${expectedNum}，当前服务端为 rev ${currentRev}`,
              409,
              {
                expected_revision: expectedNum,
                current_revision: currentRev,
                server_note: readFullNote(tx, date),
              },
            );
          }
        }

        const now = nowIso();
        if (existing) {
          insertRevisionSnapshot(tx, {
            noteDate: date,
            revision: existing.revision,
            contentMd: existing.content_md,
            source: 'restore_backup',
            summary: `恢复至快照 rev ${targetRev.revision} 前的自动备份`,
            createdAt: now,
          });
        }

        writeNoteContent(tx, {
          date,
          nextMd: targetRev.content_md,
          editor: 'user',
          existingRow: existing,
          now,
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
        markdown: formatExportMarkdown(note, { frontmatter: Boolean(frontmatter) }),
      };
    },

    listRecentNotes({ limit = 60, offset = 0 } = {}) {
      const safeLimit = Math.min(200, Math.max(1, Number(limit) || 60));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const total = adapter.get(
        'SELECT COUNT(*) AS cnt FROM notes WHERE length(trim(content_md)) > 0',
      ).cnt;
      const rows = adapter.all(
        `SELECT date, title, word_count, todo_total, todo_done, revision, updated_at
         FROM notes
         WHERE length(trim(content_md)) > 0
         ORDER BY date DESC
         LIMIT ? OFFSET ?`,
        safeLimit,
        safeOffset,
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
          updated_at: r.updated_at,
        })),
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
        safeLimit,
      );
      return rows
        .map((r) => `${r.date}|${r.title}|${r.revision}|${r.todo_done}/${r.todo_total}|${r.updated_at}`)
        .join('\n');
    },

    saveAttachment(payload) {
      return saveAttachment(dbCtx, payload);
    },

    getAttachment(id) {
      return getAttachment(dbCtx, id);
    },

    cleanupOrphanedAttachments(opts) {
      return cleanupOrphanedAttachments(dbCtx, opts);
    },
  };
}
