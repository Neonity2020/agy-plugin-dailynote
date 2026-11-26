import crypto from 'node:crypto';
import { isValidDateString } from './config.mjs';

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])(?:\s+(.*))?$/;
const TAG_RE = /(?:^|[\s(（【\[])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,48})/gu;
const WIKILINK_RE = /\[\[(\d{4}-\d{2}-\d{2})\]\]/g;
const ATTACHMENT_URL_RE = /\/api\/attachments?\/([a-zA-Z0-9_-]{12,64})|\/api\/attachment\?id=([a-zA-Z0-9_-]{12,64})/g;
const CJK_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
const LATIN_WORD_RE = /[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g;

export function normalizeLineEndings(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizeTodoText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function isClosingFence(line, fenceChar, fenceLen) {
  const escaped = fenceChar === '`' ? '`' : '~';
  const re = new RegExp(`^\\s{0,3}${escaped}{${fenceLen},}\\s*$`);
  return re.test(line);
}

/**
 * Annotate lines with fence state (1-based line numbers).
 */
function parseLinesWithFences(contentMd) {
  const normalized = normalizeLineEndings(contentMd);
  const rawLines = normalized.split('\n');
  let activeFence = null; // { char, len }

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
      // Backtick info strings cannot contain another backtick per CommonMark
      if (!(marker[0] === '`' && openMatch[2].includes('`'))) {
        activeFence = { char: marker[0], len: marker.length };
        return { lineNumber, line, inFence: true, isFenceBoundary: true };
      }
    }
    return { lineNumber, line, inFence: false, isFenceBoundary: false };
  });
}

function stripInlineCode(text) {
  // Replace inline code spans (`...` or ``...``) with spaces so tags/links inside them are ignored
  return text.replace(/(`+)([\s\S]*?)\1/g, ' ');
}

function stripMarkdownUrls(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/https?:\/\/[^\s)>\]]+/gi, ' ');
}

function stripMarkdownSyntaxForPlainText(linesWithFences) {
  const out = [];
  for (const entry of linesWithFences) {
    if (entry.isFenceBoundary) continue;
    let text = entry.line;
    if (!entry.inFence) {
      text = text
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s*/, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/, '')
        .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/, '');
      text = stripMarkdownUrls(text);
      text = text
        .replace(/\|/g, ' ')
        .replace(/(`+)([^`]*)\1/g, '$2')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/==(.*?)==/g, '$1')
        .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
        .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
        .replace(/\[\[(\d{4}-\d{2}-\d{2})\]\]/g, '$1');
    }
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed) out.push(collapsed);
  }
  return out.join('\n');
}

export function countWords(plainText) {
  if (!plainText) return 0;
  const cjkMatches = plainText.match(CJK_CHAR_RE) || [];
  const withoutCjk = plainText.replace(CJK_CHAR_RE, ' ');
  const latinMatches = withoutCjk.match(LATIN_WORD_RE) || [];
  return cjkMatches.length + latinMatches.length;
}

/**
 * Extract title, plain_text, word_count, todos, tags, links, and attachment_ids from Markdown.
 */
export function extractMetadata(contentMd) {
  const normalized = normalizeLineEndings(contentMd);
  const lines = parseLinesWithFences(normalized);

  let title = '';
  const todos = [];
  const tagSet = new Set();
  const linkSet = new Set();

  for (const entry of lines) {
    if (entry.inFence) continue;

    // Title from first ATX heading
    if (!title) {
      const hMatch = ATX_HEADING_RE.exec(entry.line);
      if (hMatch) {
        title = hMatch[2].trim();
      }
    }

    // Todos (outside fenced code blocks)
    const tMatch = TASK_LINE_RE.exec(entry.line);
    if (tMatch) {
      const completed = tMatch[2].toLowerCase() === 'x';
      const rawText = (tMatch[4] ?? '').trim();
      if (rawText.length > 0) {
        const normText = normalizeTodoText(rawText);
        todos.push({
          lineNumber: entry.lineNumber,
          completed,
          text: rawText,
          normalizedText: normText,
          hash: sha256Hex(normText),
        });
      }
    }

    // Strip inline code and URLs before tag/wikilink extraction
    const withoutCode = stripInlineCode(entry.line);

    // Date wikilinks [[YYYY-MM-DD]]
    for (const match of withoutCode.matchAll(WIKILINK_RE)) {
      const dateStr = match[1];
      if (isValidDateString(dateStr)) {
        linkSet.add(dateStr);
      }
    }

    // Inline #tags (exclude heading hashes and URL anchors)
    const lineForTags = stripMarkdownUrls(withoutCode).replace(/^\s{0,3}#{1,6}\s+/, '');
    for (const match of lineForTags.matchAll(TAG_RE)) {
      const cleanTag = match[1].replace(/[-/]+$/, '').toLowerCase();
      if (cleanTag) {
        tagSet.add(cleanTag);
      }
    }
  }

  const plain_text = stripMarkdownSyntaxForPlainText(lines);
  if (!title && plain_text) {
    const firstLine = plain_text.split('\n')[0].trim();
    title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }

  const attachmentSet = new Set();
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
    attachment_ids: [...attachmentSet],
  };
}

function normalizeHeadingText(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#*\s*$/, '')
    .trim();
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

    // Find next heading of level <= current level outside fences
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

/**
 * Append Markdown safely either to the end of the document or under a specific heading.
 */
export function appendMarkdown(existingMd, newMd, heading) {
  const existingNorm = normalizeLineEndings(existingMd).trimEnd();
  const addition = normalizeLineEndings(newMd).trim();
  if (!addition) return existingNorm;

  if (!heading || !heading.trim()) {
    return existingNorm ? `${existingNorm}\n\n${addition}` : addition;
  }

  const cleanHeading = normalizeHeadingText(heading);
  if (!existingNorm) {
    return `## ${cleanHeading}\n\n${addition}`;
  }

  const lines = parseLinesWithFences(existingNorm);
  const range = findHeadingSectionRange(lines, cleanHeading);
  if (!range) {
    return `${existingNorm}\n\n## ${cleanHeading}\n\n${addition}`;
  }

  const rawLines = existingNorm.split('\n');
  let insertAt = range.endIdx;
  while (insertAt > range.headingIdx + 1 && rawLines[insertAt - 1].trim() === '') {
    insertAt -= 1;
  }

  const before = rawLines.slice(0, insertAt);
  const after = rawLines.slice(range.endIdx);

  const chunks = [];
  if (before.length) chunks.push(before.join('\n').trimEnd());
  chunks.push(addition);
  if (after.length) chunks.push(after.join('\n').replace(/^\n+/, ''));

  return chunks.filter(Boolean).join('\n\n').trimEnd();
}

/**
 * Replace the body under a specific heading while preserving the heading line itself.
 */
export function replaceSectionMarkdown(existingMd, heading, newMd) {
  const existingNorm = normalizeLineEndings(existingMd);
  const lines = parseLinesWithFences(existingNorm);
  const range = findHeadingSectionRange(lines, heading);
  if (!range) {
    return { found: false, content_md: existingNorm };
  }

  const rawLines = existingNorm.split('\n');
  const headingLine = rawLines[range.headingIdx];
  const before = rawLines.slice(0, range.headingIdx);
  const after = rawLines.slice(range.endIdx);
  const replacement = normalizeLineEndings(newMd).trim();

  const parts = [];
  if (before.length) parts.push(before.join('\n').trimEnd());
  if (replacement) {
    parts.push(`${headingLine}\n\n${replacement}`);
  } else {
    parts.push(headingLine);
  }
  if (after.length) parts.push(after.join('\n').replace(/^\n+/, ''));

  return {
    found: true,
    content_md: parts.filter((p) => p !== '').join('\n\n').trimEnd(),
  };
}

/**
 * Toggle a single task item line by 1-based lineNumber or matchText.
 */
export function toggleTodoLine(contentMd, { lineNumber, matchText, completed }) {
  const normalized = normalizeLineEndings(contentMd);
  const lines = parseLinesWithFences(normalized);
  const rawLines = normalized.split('\n');

  const todos = [];
  for (const entry of lines) {
    if (entry.inFence) continue;
    const match = TASK_LINE_RE.exec(entry.line);
    if (!match) continue;
    const text = (match[4] ?? '').trim();
    todos.push({
      lineNumber: entry.lineNumber,
      prefix: match[1],
      currentMark: match[2],
      suffix: match[3],
      text,
      completed: match[2].toLowerCase() === 'x',
    });
  }

  let target = null;
  if (lineNumber != null) {
    target = todos.find((t) => t.lineNumber === lineNumber) || null;
    if (!target) {
      return { ok: false, errorCode: 'TODO_NOT_FOUND', message: `第 ${lineNumber} 行不是有效的任务项` };
    }
  } else if (typeof matchText === 'string' && matchText.trim()) {
    const needle = matchText.trim().toLowerCase();
    const exact = todos.filter((t) => t.text.toLowerCase() === needle);
    const candidates = exact.length > 0
      ? exact
      : todos.filter((t) => t.text.toLowerCase().includes(needle));
    if (candidates.length === 0) {
      return { ok: false, errorCode: 'TODO_NOT_FOUND', message: `未找到匹配 "${matchText}" 的任务项` };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        errorCode: 'AMBIGUOUS_TODO_MATCH',
        message: `匹配到 ${candidates.length} 条任务项，请指定 line_number 精确选择`,
        candidates: candidates.map((c) => ({ line_number: c.lineNumber, text: c.text, completed: c.completed })),
      };
    }
    target = candidates[0];
  } else {
    return { ok: false, errorCode: 'INVALID_INPUT', message: '必须提供 line_number 或 match_text' };
  }

  const nextCompleted = Boolean(completed);
  const changed = target.completed !== nextCompleted;
  const markChar = nextCompleted ? 'x' : ' ';
  const tail = target.text ? ` ${target.text}` : '';
  rawLines[target.lineNumber - 1] = `${target.prefix}${markChar}${target.suffix}${tail}`;

  return {
    ok: true,
    changed,
    content_md: rawLines.join('\n'),
    line_number: target.lineNumber,
    text: target.text,
    completed: nextCompleted,
  };
}

/**
 * Prepend or append carried-over tasks into today's note under "## 待办顺延 (来自 YYYY-MM-DD)".
 */
export function buildCarryOverSection(existingMd, sourceDate, items) {
  const heading = `待办顺延 (来自 ${sourceDate})`;
  const taskLines = items.map((item) => `- [ ] ${item.text}`).join('\n');
  const existingNorm = normalizeLineEndings(existingMd).trim();
  if (!existingNorm) {
    return `## ${heading}\n\n${taskLines}`;
  }
  const lines = parseLinesWithFences(existingNorm);
  if (findHeadingSectionRange(lines, heading)) {
    return appendMarkdown(existingNorm, taskLines, heading);
  }
  return `## ${heading}\n\n${taskLines}\n\n${existingNorm}`;
}

export function escapeLike(str) {
  return String(str ?? '').replace(/[\\%_]/g, '\\$&');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate an HTML-safe snippet with <mark> highlights for 1-2 character LIKE fallback searches.
 */
export function buildShortSnippet(plainText, query, radius = 48) {
  const text = String(plainText ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const needle = String(query ?? '').trim();
  if (!needle) {
    const truncated = text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
    return escapeHtml(truncated);
  }

  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const hitIndex = lowerText.indexOf(lowerNeedle);
  if (hitIndex < 0) {
    const truncated = text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
    return escapeHtml(truncated);
  }

  const start = Math.max(0, hitIndex - radius);
  const end = Math.min(text.length, hitIndex + needle.length + radius);
  const slice = text.slice(start, end);

  let html = start > 0 ? '...' : '';
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
  if (end < text.length) html += '...';
  return html;
}

/**
 * Format note content as a single-day GFM export file, optionally with YAML frontmatter.
 */
export function formatExportMarkdown(note, { frontmatter = false } = {}) {
  const body = normalizeLineEndings(note.content_md || '').trimEnd();
  if (!frontmatter) {
    return body ? `${body}\n` : '';
  }

  const tagsYaml = note.tags?.length
    ? `[${note.tags.map((t) => JSON.stringify(t)).join(', ')}]`
    : '[]';
  const projectsYaml = note.projects?.length
    ? `[${note.projects.map((p) => JSON.stringify(p.workspace_name || p.workspace_uri)).join(', ')}]`
    : '[]';

  const header = [
    '---',
    `date: ${note.date}`,
    `revision: ${note.revision ?? 0}`,
    `tags: ${tagsYaml}`,
    `projects: ${projectsYaml}`,
    `updated_at: ${JSON.stringify(note.updated_at || '')}`,
    '---',
    '',
  ].join('\n');

  return body ? `${header}${body}\n` : header;
}
