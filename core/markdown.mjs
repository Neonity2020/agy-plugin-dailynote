/**
 * Markdown 解析与就地改写。
 *
 * 规范来源：docs/DATA_MODEL.md 第 5 节。所有派生数据（plain_text / word_count /
 * todo_total / todo_done / #tag / [[date]] / 附件引用）都在同一写事务内由本模块计算。
 *
 * 约定：除代码块围栏内的内容外，`#tag` 与 `[[YYYY-MM-DD]]` 都会被索引；围栏代码块、
 * 行内代码、URL 锚点与行首标题符号不参与提取。
 */

import { createHash } from 'node:crypto';

import { isValidDateString } from './config.mjs';

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\]\s+)(.*)$/;
const TAG_RE = /(?:^|[\s(（【])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,48})/gu;
const WIKILINK_RE = /\[\[(\d{4}-\d{2}-\d{2})\]\]/g;
const ATTACHMENT_REF_RE = /\/api\/attachments\/([a-zA-Z0-9_-]{12,64})/g;
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const LATIN_WORD_RE = /[A-Za-z0-9][A-Za-z0-9_'’-]*/g;

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function mdError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 按围栏代码块切分文档，保留原始行结构。
 *
 * @param {string} content
 * @returns {{ code: boolean, lines: string[] }[]}
 */
export function segmentByFences(content) {
  const lines = String(content ?? '').split('\n');
  /** @type {{ code: boolean, lines: string[] }[]} */
  const segments = [];
  /** @type {null | string} */
  let fence = null;
  let buffer = [];
  let bufferIsCode = false;

  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({ code: bufferIsCode, lines: buffer });
    buffer = [];
  };

  for (const line of lines) {
    const opener = FENCE_OPEN_RE.exec(line);

    if (fence === null) {
      if (opener) {
        flush();
        fence = opener[1];
        bufferIsCode = true;
        buffer.push(line);
      } else {
        if (bufferIsCode) flush();
        bufferIsCode = false;
        buffer.push(line);
      }
      continue;
    }

    buffer.push(line);
    if (
      opener &&
      opener[1][0] === fence[0] &&
      opener[1].length >= fence.length &&
      opener[2].trim() === ''
    ) {
      fence = null;
      flush();
      bufferIsCode = false;
    }
  }

  flush();
  return segments;
}

/**
 * 把围栏代码块的行替换为空行（保持行号一一对应）。
 *
 * @param {string} content
 * @returns {string[]}
 */
export function maskedLines(content) {
  /** @type {string[]} */
  const out = [];
  for (const segment of segmentByFences(content)) {
    for (let i = 0; i < segment.lines.length; i += 1) out.push(segment.code ? '' : segment.lines[i]);
  }
  return out;
}

/**
 * 去掉行内代码（保留行数）。
 *
 * @param {string} line
 * @returns {string}
 */
export function stripInlineCode(line) {
  return String(line ?? '').replace(/`+[^`]*`+/g, ' ');
}

/**
 * 生成用于检索与字数的纯文本：去掉围栏语法行，保留代码正文，剥离 Markdown 标记。
 *
 * @param {string} content
 * @returns {string}
 */
export function toPlainText(content) {
  const kept = [];
  for (const segment of segmentByFences(content)) {
    if (!segment.code) {
      kept.push(...segment.lines);
      continue;
    }
    const body = [...segment.lines];
    if (body.length > 0 && FENCE_OPEN_RE.test(body[0])) body.shift();
    const last = body[body.length - 1];
    if (body.length > 0 && last !== undefined && /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(last)) {
      body.pop();
    }
    kept.push(...body);
  }

  return kept
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/(^|[\s(（【])#(?=[\p{L}\p{N}_])/gmu, '$1')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\[[ xX]\][ \t]?/gm, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\|/g, ' ')
    .replace(/<[^>\n]+>/g, '')
    .replace(/[*_~`]+/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} text
 * @returns {number} 中文按字、英文按词
 */
export function countWords(text) {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const latin = text.match(LATIN_WORD_RE)?.length ?? 0;
  return cjk + latin;
}

/**
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  return String(tag ?? '')
    .toLowerCase()
    .replace(/[-/]+$/, '');
}

/**
 * 提取正文标签（排除代码块、行内代码、URL 锚点与标题符号）。
 *
 * @param {string} content
 * @returns {string[]} 小写去重
 */
export function extractTags(content) {
  const tags = new Set();
  for (const rawLine of maskedLines(content)) {
    const line = stripInlineCode(rawLine)
      .replace(/\]\([^)\s]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '');
    for (const match of line.matchAll(TAG_RE)) {
      const tag = normalizeTag(match[1]);
      if (tag) tags.add(tag);
    }
  }
  return [...tags].sort();
}

/**
 * 提取合法日期的 [[YYYY-MM-DD]] 双链。
 *
 * @param {string} content
 * @returns {string[]} 去重升序
 */
export function extractDateLinks(content) {
  const links = new Set();
  for (const rawLine of maskedLines(content)) {
    const line = stripInlineCode(rawLine);
    for (const match of line.matchAll(WIKILINK_RE)) {
      if (isValidDateString(match[1])) links.add(match[1]);
    }
  }
  return [...links].sort();
}

/**
 * 提取正文中的 /api/attachments/<id> 引用。
 *
 * @param {string} content
 * @returns {string[]} 去重
 */
export function extractAttachmentIds(content) {
  const ids = new Set();
  for (const match of String(content ?? '').matchAll(ATTACHMENT_REF_RE)) ids.add(match[1]);
  return [...ids];
}

/**
 * 提取未完成待办（行号为 1 基，跳过围栏代码块）。
 *
 * @param {string} content
 * @returns {{ line_number: number, text: string }[]}
 */
export function extractOpenTodos(content) {
  const out = [];
  const lines = maskedLines(content);
  for (let index = 0; index < lines.length; index += 1) {
    const match = TASK_LINE_RE.exec(lines[index]);
    if (!match) continue;
    if (match[2].toLowerCase() === 'x') continue;
    out.push({ line_number: index + 1, text: match[4].trim() });
  }
  return out;
}

/**
 * 解析写入所需的全部派生数据。
 *
 * @param {string} content
 * @returns {{
 *   plain_text: string,
 *   word_count: number,
 *   todo_total: number,
 *   todo_done: number,
 *   open_todos: { line_number: number, text: string }[],
 *   tags: string[],
 *   links: string[],
 *   attachment_ids: string[],
 * }}
 */
export function parseMarkdownMeta(content) {
  const source = String(content ?? '');
  const lines = maskedLines(source);
  let todoTotal = 0;
  let todoDone = 0;
  const openTodos = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = TASK_LINE_RE.exec(lines[index]);
    if (!match) continue;
    todoTotal += 1;
    if (match[2].toLowerCase() === 'x') todoDone += 1;
    else openTodos.push({ line_number: index + 1, text: match[4].trim() });
  }

  const plainText = toPlainText(source);

  return {
    plain_text: plainText,
    word_count: countWords(plainText),
    todo_total: todoTotal,
    todo_done: todoDone,
    open_todos: openTodos,
    tags: extractTags(source),
    links: extractDateLinks(source),
    attachment_ids: extractAttachmentIds(source),
  };
}

/**
 * 待办归一化哈希（空白归一化后 sha256）。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTodoHash(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\[[ xX]\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 追加到文档末尾。
 *
 * @param {string} content
 * @param {string} markdown
 * @returns {string}
 */
export function appendMarkdown(content, markdown) {
  const base = String(content ?? '').replace(/\s+$/, '');
  const addition = String(markdown ?? '').trim();
  if (!addition) return base;
  if (!base) return addition;
  return `${base}\n\n${addition}`;
}

/**
 * 找到标题小节的范围（跳过围栏代码块内的伪标题）。
 *
 * @param {string[]} lines
 * @param {string} heading
 * @returns {{ index: number, level: number, end: number } | null}
 */
function findSection(lines, heading) {
  const target = String(heading ?? '').trim().toLowerCase();
  if (!target) return null;

  const headingAt = (index) => {
    const match = /^(#{1,6})[ \t]+(.*)$/.exec(lines[index]);
    return match ? { level: match[1].length, text: match[2].trim().toLowerCase() } : null;
  };

  const masked = maskedLines(lines.join('\n'));
  const isCode = (index) => masked[index] === '' && lines[index] !== '';

  for (let index = 0; index < lines.length; index += 1) {
    if (isCode(index)) continue;
    const found = headingAt(index);
    if (!found || found.text !== target) continue;

    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (isCode(cursor)) continue;
      const next = headingAt(cursor);
      if (next && next.level <= found.level) {
        end = cursor;
        break;
      }
    }
    return { index, level: found.level, end };
  }
  return null;
}

/**
 * 向指定小节末尾追加；小节不存在时在文末新建。
 *
 * @param {string} content
 * @param {string} heading
 * @param {string} markdown
 * @returns {string}
 */
export function appendToSectionInMarkdown(content, heading, markdown) {
  const addition = String(markdown ?? '').trim();
  const base = String(content ?? '');
  if (!addition) return base.replace(/\s+$/, '');

  const lines = base.split('\n');
  const section = findSection(lines, heading);
  if (!section) {
    return appendMarkdown(base, `## ${String(heading).trim()}\n\n${addition}`);
  }

  const before = lines.slice(0, section.end).join('\n').replace(/\s+$/, '');
  const after = lines.slice(section.end).join('\n').replace(/^\s+/, '');
  const merged = `${before}\n\n${addition}`;
  return after ? `${merged}\n\n${after}` : merged;
}

/**
 * 用新内容替换标题小节正文；小节不存在时在文末新建。
 *
 * @param {string} content
 * @param {string} heading
 * @param {string} markdown
 * @returns {{ content_md: string, created: boolean }}
 */
export function replaceSectionInMarkdown(content, heading, markdown) {
  const title = String(heading ?? '').trim();
  if (!title) throw mdError('HEADING_REQUIRED', 'replace_section 需要提供 heading');

  const base = String(content ?? '');
  const lines = base.split('\n');
  const section = findSection(lines, title);
  const body = String(markdown ?? '').trim();

  if (!section) {
    return { content_md: appendMarkdown(base, `## ${title}\n\n${body}`), created: true };
  }

  const head = lines.slice(0, section.index + 1).join('\n');
  const tail = lines.slice(section.end).join('\n').replace(/^\s+/, '');
  const merged = body ? `${head}\n\n${body}` : head;
  return { content_md: tail ? `${merged}\n\n${tail}` : merged, created: false };
}

/**
 * 切换任务行完成态。
 *
 * @param {string} content
 * @param {{ line_number?: number, match_text?: string, completed: boolean }} options
 * @returns {{ content_md: string, line_number: number, text: string }}
 */
export function toggleTodoInMarkdown(content, options) {
  const lines = String(content ?? '').split('\n');
  const masked = maskedLines(content);
  const wanted = options.completed ? 'x' : ' ';
  const needle = String(options.match_text ?? '').trim();

  /** @param {number} index */
  const matchesNeedle = (index) => {
    const match = TASK_LINE_RE.exec(masked[index]);
    return Boolean(match) && match[4].includes(needle);
  };

  let target = -1;
  const requested = Number(options.line_number);
  if (Number.isInteger(requested) && requested >= 1 && requested <= lines.length) {
    const index = requested - 1;
    if (TASK_LINE_RE.test(masked[index]) && (!needle || matchesNeedle(index))) target = index;
  }
  if (target === -1 && needle) {
    for (let index = 0; index < masked.length; index += 1) {
      if (matchesNeedle(index)) {
        target = index;
        break;
      }
    }
  }
  if (target === -1) {
    const scope = needle ? `匹配「${needle}」` : `第 ${options.line_number} 行`;
    throw mdError('TODO_NOT_FOUND', `未找到${scope}的待办行`);
  }

  const match = TASK_LINE_RE.exec(lines[target]);
  const text = match[4].trim();
  lines[target] = `${match[1]}${wanted}${match[3]}${match[4]}`;

  return { content_md: lines.join('\n'), line_number: target + 1, text };
}

/**
 * 单日 Markdown 导出（GFM，可选 frontmatter）。
 *
 * @param {{
 *   date: string,
 *   content_md?: string,
 *   revision?: number,
 *   created_at?: string | null,
 *   updated_at?: string | null,
 *   tags?: string[],
 *   projects?: { workspace_uri: string, workspace_name: string }[],
 *   frontmatter?: boolean,
 * }} note
 * @returns {string}
 */
export function formatSingleDayExport(note) {
  const body = String(note.content_md ?? '').replace(/\s+$/, '');
  const lines = [];

  if (note.frontmatter) {
    const tags = (note.tags ?? []).map((tag) => JSON.stringify(tag)).join(', ');
    lines.push('---', `date: ${note.date}`, `revision: ${Number(note.revision ?? 0)}`);
    if (note.created_at) lines.push(`created_at: ${note.created_at}`);
    if (note.updated_at) lines.push(`updated_at: ${note.updated_at}`);
    lines.push(`tags: [${tags}]`);
    if (note.projects?.length) {
      lines.push('projects:');
      for (const project of note.projects) {
        lines.push(`  - ${JSON.stringify(project.workspace_name)} (${project.workspace_uri})`);
      }
    }
    lines.push('---', '');
  }

  const heading = `# ${note.date}`;
  if (body.startsWith('# ') && body.split('\n')[0].trim() === heading) {
    lines.push(body);
  } else {
    lines.push(heading, '', body);
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
