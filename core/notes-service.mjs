/**
 * 笔记事务服务 —— Sidecar 与 MCP Server 共享的唯一写入通道。
 *
 * 规则来源：docs/DATA_MODEL.md 第 6 节、docs/ARCHITECTURE.md 第 5、6 节。
 * - 所有写操作走 BEGIN IMMEDIATE 事务，并在同一事务内同步派生索引
 * - Agent 写入与回滚前自动快照，单篇仅保留最近 50 条
 * - 乐观锁：expected_revision 不匹配时抛 REVISION_CONFLICT，force 可强制覆盖
 */

import {
  addDays,
  daysBetween,
  formatLocalDate,
  isValidDateString,
  isValidMonthString,
  listDaysInMonth,
  toTimestamp,
} from './config.mjs';
import {
  appendMarkdown,
  appendToSectionInMarkdown,
  extractOpenTodos,
  formatSingleDayExport,
  normalizeTodoHash,
  parseMarkdownMeta,
  replaceSectionInMarkdown,
  toggleTodoInMarkdown,
} from './markdown.mjs';
import { reconcileAttachmentOrphans } from './attachments.mjs';

export const SNAPSHOT_LIMIT = 50;
export const CARRY_LOOKBACK_DAYS = 30;
export const MAX_RANGE_DAYS = 90;
export const DEFAULT_OPEN_TODO_DAYS = 7;
export const EDITORS = Object.freeze(['user', 'agent', 'system']);

export class NotesError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NotesError';
    this.code = code;
    this.details = details;
  }
}

export class RevisionConflictError extends NotesError {
  /**
   * @param {string} date
   * @param {number} expected
   * @param {number} current
   * @param {Record<string, unknown>} [currentNote]
   */
  constructor(date, expected, current, currentNote) {
    super('REVISION_CONFLICT', `${date} 的版本已变化（期望 rev ${expected}，当前 rev ${current}）`, {
      date,
      expected_revision: expected,
      current_revision: current,
    });
    this.name = 'RevisionConflictError';
    this.currentNote = currentNote ?? null;
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requireRevision(value, field = 'expected_revision') {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new NotesError('INVALID_REVISION', `${field} 必须是非负整数`);
  }
  return revision;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * @param {string} plainText
 * @param {string} needle
 * @param {number} [window]
 * @returns {string}
 */
function likeSnippet(plainText, needle, window = 48) {
  const haystack = String(plainText ?? '');
  const index = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return haystack.slice(0, window);
  const start = Math.max(0, index - Math.floor(window / 2));
  const end = Math.min(haystack.length, index + needle.length + Math.floor(window / 2));
  const prefix = start > 0 ? '...' : '';
  const suffix = end < haystack.length ? '...' : '';
  return `${prefix}${haystack.slice(start, index)}<mark>${haystack.slice(index, index + needle.length)}</mark>${haystack.slice(index + needle.length, end)}${suffix}`;
}

/**
 * @param {string} content
 * @returns {string}
 */
function deriveTitle(content) {
  for (const line of String(content ?? '').split('\n')) {
    const heading = /^#{1,6}[ \t]+(.+)$/.exec(line.trim());
    if (heading) return heading[1].trim().slice(0, 120);
    const text = line.trim();
    if (text) return text.replace(/^[*_~`>#\s-]+/, '').slice(0, 120);
  }
  return '';
}

export class NotesService {
  #adapter;
  #dataDir;
  #now;

  /**
   * @param {{
   *   adapter: import('./storage-adapter.mjs').StorageAdapter,
   *   dataDir?: string | null,
   *   now?: () => Date,
   * }} options
   */
  constructor(options) {
    if (!options?.adapter) throw new TypeError('NotesService 需要 StorageAdapter');
    this.#adapter = options.adapter;
    this.#dataDir = options.dataDir ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  /** @returns {import('./storage-adapter.mjs').StorageAdapter} */
  get adapter() {
    return this.#adapter;
  }

  #ts() {
    return toTimestamp(this.#now());
  }

  #today() {
    return formatLocalDate(this.#now());
  }

  /**
   * @param {string} date
   * @returns {Record<string, any> | undefined}
   */
  #row(date) {
    return this.#adapter.get('SELECT * FROM notes WHERE date = ?', date);
  }

  /**
   * @param {string} date
   * @returns {string[]}
   */
  #tags(date) {
    return this.#adapter
      .all('SELECT tag FROM note_tags WHERE note_date = ? ORDER BY tag ASC', date)
      .map((row) => row.tag);
  }

  /**
   * @param {string} date
   * @returns {{ workspace_uri: string, workspace_name: string, linked_by: string, created_at: string }[]}
   */
  #projects(date) {
    return this.#adapter.all(
      'SELECT workspace_uri, workspace_name, linked_by, created_at FROM note_projects WHERE note_date = ? ORDER BY created_at ASC, workspace_uri ASC',
      date,
    );
  }

  /**
   * @param {string} date
   * @returns {string[]}
   */
  #backlinks(date) {
    return this.#adapter
      .all('SELECT source_date FROM note_links WHERE target_date = ? ORDER BY source_date DESC LIMIT 50', date)
      .map((row) => row.source_date);
  }

  /**
   * @param {Record<string, any> | undefined} row
   * @returns {Record<string, any>}
   */
  #hydrate(row) {
    return {
      date: row.date,
      exists: true,
      title: row.title,
      content_md: row.content_md,
      plain_text: row.plain_text,
      word_count: row.word_count,
      todo_total: row.todo_total,
      todo_done: row.todo_done,
      open_todo_count: Math.max(0, row.todo_total - row.todo_done),
      revision: row.revision,
      last_editor: row.last_editor,
      carry_over_from: row.carry_over_from ?? null,
      carry_over_dismissed: Boolean(row.carry_over_dismissed),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_agent_at: row.last_agent_at ?? null,
      tags: this.#tags(row.date),
      projects: this.#projects(row.date),
      backlinks: this.#backlinks(row.date),
    };
  }

  /**
   * @param {string} date
   * @returns {Record<string, any>}
   */
  #virtual(date) {
    return {
      date,
      exists: false,
      title: '',
      content_md: '',
      plain_text: '',
      word_count: 0,
      todo_total: 0,
      todo_done: 0,
      open_todo_count: 0,
      revision: 0,
      last_editor: 'user',
      carry_over_from: null,
      carry_over_dismissed: false,
      created_at: null,
      updated_at: null,
      last_agent_at: null,
      tags: [],
      projects: [],
      backlinks: [],
    };
  }

  /**
   * 从 target 往前回溯最近一篇仍存在未完成待办的笔记。
   *
   * @param {string} target
   * @returns {Record<string, any> | null}
   */
  #pendingSource(target) {
    const floor = addDays(target, -CARRY_LOOKBACK_DAYS);
    const row = this.#adapter.get(
      `SELECT date, content_md FROM notes
       WHERE date < ? AND date >= ? AND todo_total > todo_done
         AND length(trim(content_md)) > 0
       ORDER BY date DESC LIMIT 1`,
      target,
      floor,
    );
    return row ?? null;
  }

  /**
   * @param {string} date
   * @param {Record<string, any> | undefined} row
   * @returns {{ source_date: string, count: number, items: string[] } | null}
   */
  #pending(date, row) {
    if (row && row.content_md.trim() !== '') return null;
    if (row && row.carry_over_dismissed) return null;

    const source = this.#pendingSource(date);
    if (!source) return null;

    const open = extractOpenTodos(source.content_md);
    if (open.length === 0) return null;
    return { source_date: source.date, count: open.length, items: open.map((item) => item.text) };
  }

  /**
   * 确保笔记行存在（惰性创建锚点）。
   *
   * @param {string} date
   * @returns {Record<string, any>}
   */
  #ensureRow(date) {
    const row = this.#row(date);
    if (row) return row;
    const now = this.#ts();
    this.#adapter.run('INSERT INTO notes (date, created_at, updated_at) VALUES (?, ?, ?)', date, now, now);
    return /** @type {Record<string, any>} */ (this.#row(date));
  }

  /**
   * 写入一条修改前快照并裁剪到最近 SNAPSHOT_LIMIT 条。
   *
   * @param {string} date
   * @param {Record<string, any>} row
   * @param {'agent' | 'restore_backup' | 'manual_checkpoint' | 'carry_over_backup'} source
   * @param {string} summary
   */
  #snapshot(date, row, source, summary = '') {
    this.#adapter.run(
      'INSERT INTO note_revisions (note_date, revision, content_md, source, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      date,
      row.revision,
      row.content_md,
      source,
      summary,
      this.#ts(),
    );

    const excess =
      Number(this.#adapter.get('SELECT COUNT(*) AS count FROM note_revisions WHERE note_date = ?', date)?.count ?? 0) -
      SNAPSHOT_LIMIT;
    if (excess > 0) {
      this.#adapter.run(
        `DELETE FROM note_revisions WHERE note_date = ? AND id NOT IN (
           SELECT id FROM note_revisions WHERE note_date = ? ORDER BY id DESC LIMIT ?
         )`,
        date,
        date,
        SNAPSHOT_LIMIT,
      );
    }
  }

  /**
   * 重建派生索引（标签 / 双链）。
   *
   * @param {string} date
   * @param {ReturnType<typeof parseMarkdownMeta>} meta
   */
  #syncIndexes(date, meta) {
    this.#adapter.run('DELETE FROM note_tags WHERE note_date = ?', date);
    const insertTag = this.#adapter.prepare('INSERT OR IGNORE INTO note_tags (note_date, tag) VALUES (?, ?)');
    for (const tag of meta.tags) insertTag.run(date, tag);

    this.#adapter.run('DELETE FROM note_links WHERE source_date = ?', date);
    const insertLink = this.#adapter.prepare(
      'INSERT OR IGNORE INTO note_links (source_date, target_date) VALUES (?, ?)',
    );
    for (const link of meta.links) {
      if (link === date) continue;
      insertLink.run(date, link);
    }
  }

  /**
   * 写库并同步派生数据。
   *
   * @param {string} date
   * @param {Record<string, any> | undefined} row
   * @param {string} content
   * @param {'user' | 'agent' | 'system'} editor
   * @returns {Record<string, any>}
   */
  #persist(date, row, content, editor) {
    if (!EDITORS.includes(editor)) throw new NotesError('INVALID_EDITOR', `未知写入方：${editor}`);

    const meta = parseMarkdownMeta(content);
    const now = this.#ts();
    const title = deriveTitle(content);

    if (row) {
      this.#adapter.run(
        `UPDATE notes SET title = ?, content_md = ?, plain_text = ?, word_count = ?, todo_total = ?,
           todo_done = ?, revision = revision + 1, last_editor = ?, updated_at = ?,
           last_agent_at = CASE WHEN ? = 'agent' THEN ? ELSE last_agent_at END
         WHERE date = ?`,
        title,
        content,
        meta.plain_text,
        meta.word_count,
        meta.todo_total,
        meta.todo_done,
        editor,
        now,
        editor,
        now,
        date,
      );
    } else {
      this.#adapter.run(
        `INSERT INTO notes (date, title, content_md, plain_text, word_count, todo_total, todo_done,
           revision, last_editor, created_at, updated_at, last_agent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        date,
        title,
        content,
        meta.plain_text,
        meta.word_count,
        meta.todo_total,
        meta.todo_done,
        editor,
        now,
        now,
        editor === 'agent' ? now : null,
      );
    }

    this.#syncIndexes(date, meta);
    if (this.#dataDir) {
      reconcileAttachmentOrphans(this.#adapter, {
        noteDate: date,
        attachmentIds: meta.attachment_ids,
        now: this.#now(),
      });
    }

    return this.#row(date);
  }

  /**
   * @param {string} date
   * @returns {string}
   */
  #assertDate(date) {
    if (!isValidDateString(date)) throw new NotesError('INVALID_DATE', `非法日期：${String(date)}`);
    return /** @type {string} */ (date);
  }

  /**
   * 读取单日笔记（惰性，不存在时返回虚拟空笔记）。
   *
   * @param {string} date
   * @returns {Record<string, any>}
   */
  getNote(date) {
    this.#assertDate(date);
    const row = this.#row(date);
    const note = row ? this.#hydrate(row) : this.#virtual(date);
    return { ...note, yesterday_pending: this.#pending(date, row) };
  }

  /**
   * 轻量轮询元数据。
   *
   * @param {string} date
   * @returns {Record<string, any>}
   */
  getNoteMeta(date) {
    this.#assertDate(date);
    const row = this.#row(date);
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
        content_length: 0,
      };
    }
    return {
      date,
      exists: true,
      revision: row.revision,
      updated_at: row.updated_at,
      last_editor: row.last_editor,
      last_agent_at: row.last_agent_at ?? null,
      todo_total: row.todo_total,
      todo_done: row.todo_done,
      content_length: row.content_md.length,
    };
  }

  /**
   * 保存（创建或覆盖）单日笔记。
   *
   * @param {string} date
   * @param {{
   *   content_md?: string,
   *   expected_revision?: number | null,
   *   force?: boolean,
   *   editor?: 'user' | 'agent' | 'system',
   *   summary?: string,
   * }} input
   * @returns {Record<string, any>}
   */
  saveNote(date, input = {}) {
    this.#assertDate(date);
    const content = String(input.content_md ?? '');
    const editor = input.editor ?? 'user';

    return this.#adapter.transaction(() => {
      const row = this.#row(date);
      const current = row ? row.revision : 0;
      const expected = input.expected_revision != null ? requireRevision(input.expected_revision) : null;

      if (!input.force && expected != null && expected !== current) {
        throw new RevisionConflictError(date, expected, current, row ? this.#hydrate(row) : this.#virtual(date));
      }

      // Agent 写入与「冲突加载覆写」（DATA_MODEL 6.3）写前都留快照
      if (row && (editor === 'agent' || (input.force && expected != null && expected !== current))) {
        this.#snapshot(date, row, editor === 'agent' ? 'agent' : 'manual_checkpoint', input.summary ?? '');
      }
      const persisted = this.#persist(date, row, content, editor);
      return this.#hydrate(persisted);
    });
  }

  /**
   * 安全追加（优先写工具）。heading 存在时追加到该小节末尾。
   *
   * @param {string} date
   * @param {{ markdown: string, heading?: string, editor?: 'user' | 'agent' | 'system', summary?: string }} input
   * @returns {Record<string, any>}
   */
  appendNote(date, input = {}) {
    this.#assertDate(date);
    const addition = String(input.markdown ?? '').trim();
    if (!addition) throw new NotesError('EMPTY_MARKDOWN', '追加内容不能为空');
    const editor = input.editor ?? 'agent';

    return this.#adapter.transaction(() => {
      const row = this.#row(date);
      if (row && editor === 'agent') this.#snapshot(date, row, 'agent', input.summary ?? `append: ${addition.slice(0, 60)}`);

      const base = row?.content_md ?? '';
      const heading = input.heading?.trim();
      const next = heading
        ? appendToSectionInMarkdown(base, heading, addition)
        : appendMarkdown(base, addition);

      const persisted = this.#persist(date, row, next, editor);
      return this.#hydrate(persisted);
    });
  }

  /**
   * 定点切换待办状态。
   *
   * @param {string} date
   * @param {{
   *   expected_revision: number,
   *   line_number?: number,
   *   match_text?: string,
   *   completed: boolean,
   *   editor?: 'user' | 'agent' | 'system',
   * }} input
   * @returns {Record<string, any> & { toggled_line?: number }}
   */
  toggleTodo(date, input = {}) {
    this.#assertDate(date);
    const expected = requireRevision(input.expected_revision);
    const editor = input.editor ?? 'agent';

    return this.#adapter.transaction(() => {
      const row = this.#row(date);
      if (!row) throw new NotesError('NOTE_NOT_FOUND', `${date} 尚无笔记`);
      if (row.revision !== expected) throw new RevisionConflictError(date, expected, row.revision, this.#hydrate(row));

      // 先按当前 revision 校验，再做行定位；定位失败会整体回滚
      const toggled = toggleTodoInMarkdown(row.content_md, {
        line_number: input.line_number,
        match_text: input.match_text,
        completed: Boolean(input.completed),
      });

      this.#snapshot(date, row, 'agent', `toggle todo @L${toggled.line_number}`);
      const persisted = this.#persist(date, row, toggled.content_md, editor);
      return { ...this.#hydrate(persisted), toggled_line: toggled.line_number };
    });
  }

  /**
   * 受控覆盖更新（整篇或指定小节），强制乐观锁。
   *
   * @param {string} date
   * @param {{
   *   expected_revision: number,
   *   mode: 'replace' | 'replace_section',
   *   heading?: string,
   *   markdown: string,
   *   summary: string,
   *   editor?: 'user' | 'agent' | 'system',
   * }} input
   * @returns {Record<string, any>}
   */
  updateNoteControlled(date, input = {}) {
    this.#assertDate(date);
    const expected = requireRevision(input.expected_revision);
    const mode = input.mode ?? 'replace';
    if (!['replace', 'replace_section'].includes(mode)) {
      throw new NotesError('INVALID_MODE', `未知更新模式：${String(mode)}`);
    }
    const editor = input.editor ?? 'agent';
    const summary = String(input.summary ?? '').trim() || `${mode} by ${editor}`;

    return this.#adapter.transaction(() => {
      const row = this.#row(date);
      if (!row) throw new NotesError('NOTE_NOT_FOUND', `${date} 尚无笔记`);
      if (row.revision !== expected) throw new RevisionConflictError(date, expected, row.revision, this.#hydrate(row));

      let content;
      if (mode === 'replace') {
        content = String(input.markdown ?? '');
      } else {
        if (!input.heading?.trim()) throw new NotesError('HEADING_REQUIRED', 'replace_section 需要 heading');
        content = replaceSectionInMarkdown(row.content_md, input.heading, String(input.markdown ?? '')).content_md;
      }

      this.#snapshot(date, row, 'agent', summary);
      const persisted = this.#persist(date, row, content, editor);
      return this.#hydrate(persisted);
    });
  }

  /**
   * 昨日未完成待办顺延 / 忽略。
   *
   * @param {string} targetDate
   * @param {{ action?: 'apply' | 'dismiss', source_date?: string }} input
   * @returns {{ note: Record<string, any>, carried_count: number, skipped_count: number }}
   */
  carryOverTodos(targetDate, input = {}) {
    this.#assertDate(targetDate);
    const action = input.action ?? 'apply';
    if (!['apply', 'dismiss'].includes(action)) throw new NotesError('INVALID_ACTION', `未知动作：${action}`);
    if (input.source_date != null) this.#assertDate(input.source_date);

    return this.#adapter.transaction(() => {
      const row = this.#ensureRow(targetDate);

      if (action === 'dismiss') {
        this.#adapter.run('UPDATE notes SET carry_over_dismissed = 1 WHERE date = ?', targetDate);
        return { note: this.#hydrate(this.#row(targetDate)), carried_count: 0, skipped_count: 0 };
      }

      const source = input.source_date
        ? this.#adapter.get('SELECT date, content_md FROM notes WHERE date = ?', input.source_date)
        : this.#pendingSource(targetDate);

      if (!source) {
        if (!row.carry_over_dismissed) {
          this.#adapter.run('UPDATE notes SET carry_over_dismissed = 1 WHERE date = ?', targetDate);
        }
        return { note: this.#hydrate(this.#row(targetDate)), carried_count: 0, skipped_count: 0 };
      }

      const open = extractOpenTodos(source.content_md);
      const fresh = [];
      let skipped = 0;
      for (const item of open) {
        const hash = normalizeTodoHash(item.text);
        const seen = this.#adapter.get(
          'SELECT 1 AS hit FROM todo_carryovers WHERE target_date = ? AND source_date = ? AND item_hash = ?',
          targetDate,
          source.date,
          hash,
        );
        if (seen) {
          skipped += 1;
          continue;
        }
        fresh.push({ hash, text: item.text });
      }

      const now = this.#ts();
      if (fresh.length > 0) {
        const current = this.#row(targetDate);
        if (current && current.content_md.trim() !== '') {
          this.#snapshot(targetDate, current, 'carry_over_backup', `顺延前备份 (来自 ${source.date})`);
        }

        const section = `## 待办顺延 (来自 ${source.date})`;
        const lines = fresh.map((item) => `- [ ] ${item.text}`).join('\n');
        const base = current?.content_md ?? '';
        const next = base.includes(section)
          ? appendToSectionInMarkdown(base, section.replace(/^##\s+/, ''), lines)
          : appendMarkdown(base, `${section}\n\n${lines}`);

        const insertCarry = this.#adapter.prepare(
          'INSERT OR IGNORE INTO todo_carryovers (target_date, source_date, item_hash, carried_at) VALUES (?, ?, ?, ?)',
        );
        for (const item of fresh) insertCarry.run(targetDate, source.date, item.hash, now);

        this.#adapter.run(
          'UPDATE notes SET carry_over_from = ?, carry_over_dismissed = 1 WHERE date = ?',
          source.date,
          targetDate,
        );
        this.#persist(targetDate, this.#row(targetDate), next, 'user');
      } else {
        this.#adapter.run('UPDATE notes SET carry_over_dismissed = 1 WHERE date = ?', targetDate);
      }

      return {
        note: this.#hydrate(this.#row(targetDate)),
        carried_count: fresh.length,
        skipped_count: skipped,
      };
    });
  }

  /**
   * 关联工作区项目。
   *
   * @param {string} date
   * @param {{ workspace_uri: string, workspace_name: string, linked_by?: 'user' | 'agent' }} input
   * @returns {{ workspace_uri: string, workspace_name: string, linked_by: string, created_at: string }[]}
   */
  linkProject(date, input = {}) {
    this.#assertDate(date);
    const uri = String(input.workspace_uri ?? '').trim();
    const name = String(input.workspace_name ?? '').trim() || uri;
    if (!uri) throw new NotesError('INVALID_WORKSPACE', 'workspace_uri 不能为空');
    const linkedBy = input.linked_by === 'agent' ? 'agent' : 'user';

    return this.#adapter.transaction(() => {
      this.#ensureRow(date);
      this.#adapter.run(
        `INSERT INTO note_projects (note_date, workspace_uri, workspace_name, linked_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (note_date, workspace_uri)
         DO UPDATE SET workspace_name = excluded.workspace_name, linked_by = excluded.linked_by`,
        date,
        uri,
        name,
        linkedBy,
        this.#ts(),
      );
      return this.#projects(date);
    });
  }

  /**
   * 取消项目关联。
   *
   * @param {string} date
   * @param {{ workspace_uri: string }} input
   * @returns {{ workspace_uri: string, workspace_name: string, linked_by: string, created_at: string }[]}
   */
  unlinkProject(date, input = {}) {
    this.#assertDate(date);
    const uri = String(input.workspace_uri ?? '').trim();
    if (!uri) throw new NotesError('INVALID_WORKSPACE', 'workspace_uri 不能为空');

    return this.#adapter.transaction(() => {
      this.#adapter.run('DELETE FROM note_projects WHERE note_date = ? AND workspace_uri = ?', date, uri);
      return this.#projects(date);
    });
  }

  /**
   * 月度日历聚合（仅有正文的日期算活跃）。
   *
   * @param {string} month YYYY-MM
   * @param {{ tag?: string, workspace_uri?: string }} [filters]
   * @returns {{ month: string, days: { date: string, has_note: boolean, todo_total: number, todo_done: number }[] }}
   */
  getCalendarMonth(month, filters = {}) {
    if (!isValidMonthString(month)) throw new NotesError('INVALID_MONTH', `非法月份：${String(month)}`);

    const conditions = ['n.date LIKE ?', 'length(trim(n.content_md)) > 0'];
    const params = [`${month}-%`];
    if (filters.tag) {
      conditions.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)');
      params.push(filters.tag.toLowerCase());
    }
    if (filters.workspace_uri) {
      conditions.push(
        'EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)',
      );
      params.push(filters.workspace_uri);
    }

    const rows = this.#adapter.all(
      `SELECT n.date, n.todo_total, n.todo_done FROM notes n WHERE ${conditions.join(' AND ')}`,
      ...params,
    );
    const byDate = new Map(rows.map((row) => [row.date, row]));

    return {
      month,
      days: listDaysInMonth(month).map((date) => {
        const row = byDate.get(date);
        return {
          date,
          has_note: Boolean(row),
          todo_total: row?.todo_total ?? 0,
          todo_done: row?.todo_done ?? 0,
        };
      }),
    };
  }

  /**
   * 全文 / 标签 / 项目检索。>=3 字符走 FTS5 trigram，1–2 字符走 LIKE 降级。
   *
   * @param {string} query
   * @param {{ tag?: string, workspace_uri?: string, from?: string, to?: string, limit?: number, offset?: number }} [options]
   * @returns {{ total: number, mode: 'fts' | 'like' | 'filter', items: Record<string, any>[] }}
   */
  searchNotes(query, options = {}) {
    const q = String(query ?? '').trim();
    const limit = Math.min(Math.max(Number(options.limit ?? 30), 1), 100);
    const offset = Math.max(Number(options.offset ?? 0), 0);

    if (options.from != null) this.#assertDate(options.from);
    if (options.to != null) this.#assertDate(options.to);

    const filters = [];
    const filterParams = [];
    if (options.tag) {
      filters.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)');
      filterParams.push(options.tag.toLowerCase());
    }
    if (options.workspace_uri) {
      filters.push('EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)');
      filterParams.push(options.workspace_uri);
    }
    if (options.from) {
      filters.push('n.date >= ?');
      filterParams.push(options.from);
    }
    if (options.to) {
      filters.push('n.date <= ?');
      filterParams.push(options.to);
    }
    filters.push("length(trim(n.content_md)) > 0");
    const where = filters.join(' AND ');

    /** @type {'fts' | 'like' | 'filter'} */
    let mode = 'filter';

    if (q.length >= 3) {
      mode = 'fts';
      const match = `"${q.replace(/"/g, '""')}"`;
      const total = Number(
        this.#adapter.get(
          `SELECT COUNT(*) AS count FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ? AND ${where}`,
          match,
          ...filterParams,
        )?.count ?? 0,
      );
      const items = this.#adapter.all(
        `SELECT n.date, n.updated_at,
           snippet(notes_fts, 2, '<mark>', '</mark>', '...', 24) AS snippet
         FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND ${where}
         ORDER BY n.date DESC LIMIT ? OFFSET ?`,
        match,
        ...filterParams,
        limit,
        offset,
      );
      return { total, mode, items: items.map((row) => this.#searchItem(row)) };
    }

    if (q.length > 0) {
      mode = 'like';
      const needle = escapeLike(q);
      const total = Number(
        this.#adapter.get(
          `SELECT COUNT(*) AS count FROM notes n WHERE n.plain_text LIKE ? ESCAPE '\\' AND ${where}`,
          `%${needle}%`,
          ...filterParams,
        )?.count ?? 0,
      );
      const items = this.#adapter.all(
        `SELECT n.date, n.updated_at, n.plain_text FROM notes n
         WHERE n.plain_text LIKE ? ESCAPE '\\' AND ${where}
         ORDER BY n.date DESC LIMIT ? OFFSET ?`,
        `%${needle}%`,
        ...filterParams,
        limit,
        offset,
      );
      return {
        total,
        mode,
        items: items.map((row) => this.#searchItem({ ...row, snippet: likeSnippet(row.plain_text, q) })),
      };
    }

    const total = Number(
      this.#adapter.get(`SELECT COUNT(*) AS count FROM notes n WHERE ${where}`, ...filterParams)?.count ?? 0,
    );
    const items = this.#adapter.all(
      `SELECT n.date, n.updated_at, n.plain_text FROM notes n
       WHERE ${where} ORDER BY n.date DESC LIMIT ? OFFSET ?`,
      ...filterParams,
      limit,
      offset,
    );
    return {
      total,
      mode,
      items: items.map((row) => this.#searchItem({ ...row, snippet: String(row.plain_text ?? '').slice(0, 48) })),
    };
  }

  /**
   * @param {Record<string, any>} row
   * @returns {Record<string, any>}
   */
  #searchItem(row) {
    return {
      date: row.date,
      snippet: row.snippet ?? '',
      tags: this.#tags(row.date),
      projects: this.#projects(row.date),
      updated_at: row.updated_at,
    };
  }

  /**
   * 区间列出（最多 90 天）。
   *
   * @param {string} startDate
   * @param {string} endDate
   * @param {{ tag?: string, workspace_uri?: string, include_content?: boolean }} [options]
   * @returns {{ start_date: string, end_date: string, items: Record<string, any>[] }}
   */
  listRange(startDate, endDate, options = {}) {
    this.#assertDate(startDate);
    this.#assertDate(endDate);
    if (startDate > endDate) throw new NotesError('INVALID_RANGE', 'start_date 不能晚于 end_date');
    if (daysBetween(startDate, endDate) + 1 > MAX_RANGE_DAYS) {
      throw new NotesError('RANGE_TOO_WIDE', `单次最多 ${MAX_RANGE_DAYS} 天`);
    }

    const filters = ['n.date >= ?', 'n.date <= ?'];
    const params = [startDate, endDate];
    if (options.tag) {
      filters.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_date = n.date AND t.tag = ?)');
      params.push(options.tag.toLowerCase());
    }
    if (options.workspace_uri) {
      filters.push('EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)');
      params.push(options.workspace_uri);
    }

    const rows = this.#adapter.all(
      `SELECT n.* FROM notes n WHERE ${filters.join(' AND ')} AND length(trim(n.content_md)) > 0
       ORDER BY n.date DESC`,
      ...params,
    );

    return {
      start_date: startDate,
      end_date: endDate,
      items: rows.map((row) => {
        const base = {
          date: row.date,
          title: row.title,
          revision: row.revision,
          word_count: row.word_count,
          todo_total: row.todo_total,
          todo_done: row.todo_done,
          updated_at: row.updated_at,
          tags: this.#tags(row.date),
          projects: this.#projects(row.date),
        };
        if (options.include_content) base.content_md = row.content_md;
        else base.preview = row.plain_text.slice(0, 160);
        return base;
      }),
    };
  }

  /**
   * 汇总范围内未完成待办。
   *
   * @param {{ days?: number, start_date?: string, end_date?: string, workspace_uri?: string }} [options]
   * @returns {{ start_date: string, end_date: string, total: number, items: { date: string, line_number: number, text: string }[] }}
   */
  getOpenTodos(options = {}) {
    const endDate = options.end_date ?? this.#today();
    const days = Math.min(Math.max(Number(options.days ?? DEFAULT_OPEN_TODO_DAYS), 1), MAX_RANGE_DAYS);
    const startDate = options.start_date ?? addDays(endDate, -(days - 1));
    this.#assertDate(startDate);
    this.#assertDate(endDate);

    const params = [startDate, endDate];
    let workspace = '';
    if (options.workspace_uri) {
      workspace = 'AND EXISTS (SELECT 1 FROM note_projects p WHERE p.note_date = n.date AND p.workspace_uri = ?)';
      params.push(options.workspace_uri);
    }

    const rows = this.#adapter.all(
      `SELECT n.date, n.content_md FROM notes n
       WHERE n.date >= ? AND n.date <= ? AND n.todo_total > n.todo_done ${workspace}
       ORDER BY n.date DESC`,
      ...params,
    );

    const items = [];
    for (const row of rows) {
      for (const todo of extractOpenTodos(row.content_md)) {
        items.push({ date: row.date, line_number: todo.line_number, text: todo.text });
      }
    }

    return { start_date: startDate, end_date: endDate, total: items.length, items };
  }

  /**
   * 标签列表与频次。
   *
   * @param {{ q?: string, limit?: number }} [options]
   * @returns {{ tags: { tag: string, count: number }[] }}
   */
  listTags(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit ?? 200), 1), 1000);
    const prefix = options.q ? `${escapeLike(options.q.toLowerCase())}%` : '%';

    const rows = this.#adapter.all(
      `SELECT t.tag AS tag, COUNT(*) AS count
       FROM note_tags t JOIN notes n ON n.date = t.note_date
       WHERE t.tag LIKE ? ESCAPE '\\' AND length(trim(n.content_md)) > 0
       GROUP BY t.tag ORDER BY count DESC, t.tag ASC LIMIT ?`,
      prefix,
      limit,
    );
    return { tags: rows.map((row) => ({ tag: row.tag, count: Number(row.count) })) };
  }

  /**
   * 查询历史快照。
   *
   * @param {string} date
   * @param {{ limit?: number }} [options]
   * @returns {{ revisions: Record<string, any>[] }}
   */
  listRevisions(date, options = {}) {
    this.#assertDate(date);
    const limit = Math.min(Math.max(Number(options.limit ?? SNAPSHOT_LIMIT), 1), SNAPSHOT_LIMIT);

    const rows = this.#adapter.all(
      `SELECT id, revision, source, summary, created_at, substr(content_md, 1, 200) AS preview
       FROM note_revisions WHERE note_date = ? ORDER BY revision DESC, id DESC LIMIT ?`,
      date,
      limit,
    );
    return { revisions: rows };
  }

  /**
   * 恢复历史快照（恢复前自动备份当前版本）。
   *
   * @param {string} date
   * @param {number} revisionId
   * @param {{ expected_revision: number }} input
   * @returns {Record<string, any>}
   */
  restoreRevision(date, revisionId, input = {}) {
    this.#assertDate(date);
    const expected = requireRevision(input.expected_revision);
    const id = Number(revisionId);
    if (!Number.isInteger(id)) throw new NotesError('INVALID_REVISION_ID', '快照 id 必须是整数');

    return this.#adapter.transaction(() => {
      const row = this.#row(date);
      if (!row) throw new NotesError('NOTE_NOT_FOUND', `${date} 尚无笔记`);
      if (row.revision !== expected) throw new RevisionConflictError(date, expected, row.revision, this.#hydrate(row));

      const target = this.#adapter.get('SELECT content_md, revision FROM note_revisions WHERE id = ? AND note_date = ?', id, date);
      if (!target) throw new NotesError('REVISION_NOT_FOUND', `快照不存在：${id}`);

      this.#snapshot(date, row, 'restore_backup', `恢复前备份 (rev ${row.revision})`);
      const persisted = this.#persist(date, row, target.content_md, 'system');
      return this.#hydrate(persisted);
    });
  }

  /**
   * 导出单日 Markdown。
   *
   * @param {string} date
   * @param {{ frontmatter?: boolean }} [options]
   * @returns {string}
   */
  exportNoteMarkdown(date, options = {}) {
    const note = this.getNote(date);
    return formatSingleDayExport({
      date,
      content_md: note.content_md,
      revision: note.revision,
      created_at: note.created_at,
      updated_at: note.updated_at,
      tags: note.tags,
      projects: note.projects,
      frontmatter: Boolean(options.frontmatter),
    });
  }
}

/**
 * @param {{ adapter: import('./storage-adapter.mjs').StorageAdapter, dataDir?: string | null, now?: () => Date }} options
 * @returns {NotesService}
 */
export function createNotesService(options) {
  return new NotesService(options);
}
