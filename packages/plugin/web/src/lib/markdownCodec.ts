import type {
  Blockquote,
  Code,
  Heading,
  Html,
  Image,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
  Text,
} from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { isValidDateStr } from './date';

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

const ATTACHMENT_REST_RE = /^\/api\/attachments\/([a-zA-Z0-9_-]{12,64})$/;
const ATTACHMENT_QUERY_RE = /^\/api\/attachment\?id=([a-zA-Z0-9_-]{12,64})$/;
const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'sidecar:']);
const WIKILINK_SPLIT_RE = /\[\[(\d{4}-\d{2}-\d{2})\]\]/g;
const HIGHLIGHT_OR_WIKILINK_RE = /(\[\[\d{4}-\d{2}-\d{2}\]\]|==[^=\n]+==)/g;

/**
 * Validate URLs to filter dangerous protocols such as javascript: or vbscript:.
 */
export function isSafeUrl(rawUrl: string | null | undefined): boolean {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return SAFE_URL_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Map canonical /api/attachments/<id> -> /api/attachment?id=<id> for SidecarApp img rendering.
 */
export function toRenderImageUrl(src: string): string {
  const trimmed = String(src || '').trim();
  const m = ATTACHMENT_REST_RE.exec(trimmed);
  if (m) {
    return `/api/attachment?id=${m[1]}`;
  }
  return trimmed;
}

/**
 * Map /api/attachment?id=<id> back to canonical /api/attachments/<id> for stored Markdown.
 */
export function toCanonicalImageUrl(src: string): string {
  const trimmed = String(src || '').trim();
  const m = ATTACHMENT_QUERY_RE.exec(trimmed);
  if (m) {
    return `/api/attachments/${m[1]}`;
  }
  return trimmed;
}

function cloneMarks(marks: TiptapMark[]): TiptapMark[] {
  return marks.map((m) => (m.attrs ? { type: m.type, attrs: { ...m.attrs } } : { type: m.type }));
}

function splitTextIntoInlineNodes(text: string, activeMarks: TiptapMark[]): TiptapNode[] {
  if (!text) return [];
  const out: TiptapNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(HIGHLIGHT_OR_WIKILINK_RE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      out.push({
        type: 'text',
        text: text.slice(cursor, start),
        ...(activeMarks.length ? { marks: cloneMarks(activeMarks) } : {}),
      });
    }

    if (token.startsWith('[[')) {
      const dateStr = token.slice(2, -2);
      if (isValidDateStr(dateStr)) {
        out.push({
          type: 'dateWikilink',
          attrs: { date: dateStr },
        });
      } else {
        out.push({
          type: 'text',
          text: token,
          ...(activeMarks.length ? { marks: cloneMarks(activeMarks) } : {}),
        });
      }
    } else if (token.startsWith('==') && token.endsWith('==') && token.length > 4) {
      const inner = token.slice(2, -2);
      const nextMarks = [...cloneMarks(activeMarks), { type: 'highlight' }];
      // Recursively check for wikilinks inside highlighted text
      let innerCursor = 0;
      for (const wm of inner.matchAll(WIKILINK_SPLIT_RE)) {
        const wStart = wm.index ?? 0;
        if (wStart > innerCursor) {
          out.push({ type: 'text', text: inner.slice(innerCursor, wStart), marks: cloneMarks(nextMarks) });
        }
        const dateStr = wm[1];
        if (isValidDateStr(dateStr)) {
          out.push({ type: 'dateWikilink', attrs: { date: dateStr } });
        } else {
          out.push({ type: 'text', text: wm[0], marks: cloneMarks(nextMarks) });
        }
        innerCursor = wStart + wm[0].length;
      }
      if (innerCursor < inner.length) {
        out.push({ type: 'text', text: inner.slice(innerCursor), marks: cloneMarks(nextMarks) });
      }
    }

    cursor = start + token.length;
  }

  if (cursor < text.length) {
    out.push({
      type: 'text',
      text: text.slice(cursor),
      ...(activeMarks.length ? { marks: cloneMarks(activeMarks) } : {}),
    });
  }

  return out;
}

function convertPhrasing(nodes: PhrasingContent[], marks: TiptapMark[] = []): TiptapNode[] {
  const out: TiptapNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        out.push(...splitTextIntoInlineNodes((node as Text).value, marks));
        break;
      }
      case 'break': {
        out.push({ type: 'hardBreak' });
        break;
      }
      case 'inlineCode': {
        if (node.value) {
          out.push({
            type: 'text',
            text: node.value,
            marks: [...cloneMarks(marks), { type: 'code' }],
          });
        }
        break;
      }
      case 'strong': {
        out.push(...convertPhrasing(node.children, [...marks, { type: 'bold' }]));
        break;
      }
      case 'emphasis': {
        out.push(...convertPhrasing(node.children, [...marks, { type: 'italic' }]));
        break;
      }
      case 'delete': {
        out.push(...convertPhrasing(node.children, [...marks, { type: 'strike' }]));
        break;
      }
      case 'link': {
        const linkNode = node as Link;
        if (isSafeUrl(linkNode.url)) {
          out.push(
            ...convertPhrasing(linkNode.children, [
              ...marks,
              { type: 'link', attrs: { href: linkNode.url, target: '_blank' } },
            ]),
          );
        } else {
          out.push(...convertPhrasing(linkNode.children, marks));
        }
        break;
      }
      case 'image': {
        const imgNode = node as Image;
        if (isSafeUrl(imgNode.url)) {
          out.push({
            type: 'image',
            attrs: {
              src: toRenderImageUrl(imgNode.url),
              alt: imgNode.alt || '',
              title: imgNode.title || null,
            },
          });
        }
        break;
      }
      case 'html': {
        const htmlVal = (node as Html).value.trim().toLowerCase();
        if (htmlVal === '<br>' || htmlVal === '<br/>' || htmlVal === '<br />') {
          out.push({ type: 'hardBreak' });
        } else if ((node as Html).value) {
          out.push({
            type: 'text',
            text: (node as Html).value,
            ...(marks.length ? { marks: cloneMarks(marks) } : {}),
          });
        }
        break;
      }
      default: {
        if ('children' in node && Array.isArray((node as { children?: PhrasingContent[] }).children)) {
          out.push(...convertPhrasing((node as { children: PhrasingContent[] }).children, marks));
        } else if ('value' in node && typeof (node as { value?: string }).value === 'string') {
          out.push(...splitTextIntoInlineNodes((node as { value: string }).value, marks));
        }
        break;
      }
    }
  }
  return out;
}

function convertParagraph(p: Paragraph): TiptapNode[] {
  const inline = convertPhrasing(p.children);
  if (inline.length === 0) {
    return [{ type: 'paragraph' }];
  }

  // Lift block image nodes out of paragraph so Tiptap Image (block mode) stays schema-valid
  const blocks: TiptapNode[] = [];
  let buffer: TiptapNode[] = [];

  for (const child of inline) {
    if (child.type === 'image') {
      if (buffer.length > 0) {
        blocks.push({ type: 'paragraph', content: buffer });
        buffer = [];
      }
      blocks.push(child);
    } else {
      buffer.push(child);
    }
  }
  if (buffer.length > 0) {
    blocks.push({ type: 'paragraph', content: buffer });
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph' }];
}

function convertList(listNode: List): TiptapNode[] {
  const segments: Array<{ isTask: boolean; items: ListItem[] }> = [];
  for (const item of listNode.children) {
    const isTask = typeof item.checked === 'boolean';
    const last = segments[segments.length - 1];
    if (last && last.isTask === isTask) {
      last.items.push(item);
    } else {
      segments.push({ isTask, items: [item] });
    }
  }

  const out: TiptapNode[] = [];
  for (const seg of segments) {
    if (seg.isTask) {
      out.push({
        type: 'taskList',
        content: seg.items.map((item) => {
          const children = convertBlocks(item.children);
          return {
            type: 'taskItem',
            attrs: { checked: Boolean(item.checked) },
            content: ensureListItemContent(children),
          };
        }),
      });
    } else {
      const listType = listNode.ordered ? 'orderedList' : 'bulletList';
      out.push({
        type: listType,
        ...(listNode.ordered ? { attrs: { start: listNode.start ?? 1 } } : {}),
        content: seg.items.map((item) => ({
          type: 'listItem',
          content: ensureListItemContent(convertBlocks(item.children)),
        })),
      });
    }
  }
  return out;
}

function ensureListItemContent(blocks: TiptapNode[]): TiptapNode[] {
  if (blocks.length === 0) return [{ type: 'paragraph' }];
  if (blocks[0].type !== 'paragraph') {
    return [{ type: 'paragraph' }, ...blocks];
  }
  return blocks;
}

function convertTable(tableNode: Table): TiptapNode {
  const rows = tableNode.children.map((row: TableRow, rowIndex: number) => {
    const cellType = rowIndex === 0 ? 'tableHeader' : 'tableCell';
    const cells = row.children.map((cell: TableCell) => {
      const blocks = convertParagraph({ type: 'paragraph', children: cell.children });
      return {
        type: cellType,
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: blocks,
      };
    });
    return {
      type: 'tableRow',
      content: cells,
    };
  });

  return {
    type: 'table',
    content: rows,
  };
}

function convertBlocks(nodes: RootContent[]): TiptapNode[] {
  const out: TiptapNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const h = node as Heading;
        const inline = convertPhrasing(h.children).filter((c) => c.type !== 'image');
        out.push({
          type: 'heading',
          attrs: { level: Math.min(3, Math.max(1, h.depth)) },
          ...(inline.length ? { content: inline } : {}),
        });
        break;
      }
      case 'paragraph': {
        out.push(...convertParagraph(node as Paragraph));
        break;
      }
      case 'blockquote': {
        const inner = convertBlocks((node as Blockquote).children);
        out.push({
          type: 'blockquote',
          content: inner.length ? inner : [{ type: 'paragraph' }],
        });
        break;
      }
      case 'thematicBreak': {
        out.push({ type: 'horizontalRule' });
        break;
      }
      case 'code': {
        const c = node as Code;
        out.push({
          type: 'codeBlock',
          attrs: { language: c.lang || null },
          ...(c.value ? { content: [{ type: 'text', text: c.value }] } : {}),
        });
        break;
      }
      case 'list': {
        out.push(...convertList(node as List));
        break;
      }
      case 'table': {
        out.push(convertTable(node as Table));
        break;
      }
      case 'html': {
        const val = (node as Html).value.trim();
        if (val) {
          out.push({
            type: 'paragraph',
            content: [{ type: 'text', text: val }],
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/**
 * Parse canonical GFM + [[YYYY-MM-DD]] + ==highlight== Markdown into a Tiptap JSON doc.
 */
export function markdownToDoc(markdown: string): TiptapNode {
  const normalized = String(markdown ?? '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  const tree = markdownParser.parse(normalized) as Root;
  const blocks = convertBlocks(tree.children);
  return {
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
  };
}

function wrapInlineCode(text: string): string {
  const matches = text.match(/`+/g) || [];
  const maxRun = matches.reduce((acc, s) => Math.max(acc, s.length), 0);
  const fence = '`'.repeat(maxRun + 1);
  const needsPad = text.startsWith('`') || text.endsWith('`');
  return needsPad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function applyMarks(text: string, marks: TiptapMark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  // Apply code mark innermost, then formatting marks, then link outermost
  const ordered = [...marks].sort((a, b) => {
    const rank = (t: string) => {
      if (t === 'code') return 0;
      if (t === 'highlight') return 1;
      if (t === 'bold') return 2;
      if (t === 'italic') return 3;
      if (t === 'strike') return 4;
      if (t === 'link') return 5;
      return 6;
    };
    return rank(a.type) - rank(b.type);
  });

  let out = text;
  for (const mark of ordered) {
    switch (mark.type) {
      case 'code':
        out = wrapInlineCode(out);
        break;
      case 'highlight':
        out = `==${out}==`;
        break;
      case 'bold':
        out = `**${out}**`;
        break;
      case 'italic':
        out = `*${out}*`;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
        if (href && isSafeUrl(href)) {
          out = `[${out}](${href})`;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function serializeInline(nodes: TiptapNode[] | undefined, insideTableCell = false): string {
  if (!nodes || nodes.length === 0) return '';
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      const txt = node.text ?? '';
      out += applyMarks(txt, node.marks);
    } else if (node.type === 'hardBreak') {
      out += insideTableCell ? '<br>' : '\\\n';
    } else if (node.type === 'dateWikilink') {
      const dateStr = typeof node.attrs?.date === 'string' ? node.attrs.date : '';
      if (dateStr) out += `[[${dateStr}]]`;
    } else if (node.type === 'image') {
      const src = toCanonicalImageUrl(String(node.attrs?.src || ''));
      const alt = String(node.attrs?.alt || '');
      const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
      out += `![${alt}](${src}${title})`;
    }
  }
  return out;
}

function serializeTable(node: TiptapNode): string {
  const rows = node.content || [];
  if (rows.length === 0) return '';

  const matrix: string[][] = rows.map((row) =>
    (row.content || []).map((cell) => {
      const cellBlocks = cell.content || [];
      let text = '';
      let previousParagraph = false;
      for (const block of cellBlocks) {
        const isParagraph = block.type === 'paragraph';
        const value = serializeInline(block.type === 'image' ? [block] : block.content, true);
        if (!value) continue;
        if (previousParagraph && isParagraph) text += '<br>';
        text += value;
        previousParagraph = isParagraph;
      }
      return text.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
    }),
  );

  const colCount = matrix.reduce((max, r) => Math.max(max, r.length), 0);
  if (colCount === 0) return '';

  const normalizeRow = (r: string[]) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const headerLine = normalizeRow(matrix[0] || []);
  const separatorLine = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const bodyLines = matrix.slice(1).map(normalizeRow);
  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

function serializeListItem(
  item: TiptapNode,
  marker: string,
  indentLevel: number,
): string {
  const indent = '  '.repeat(indentLevel);
  const children = item.content || [];
  if (children.length === 0) {
    return `${indent}${marker} `;
  }

  const lines: string[] = [];
  children.forEach((child, idx) => {
    if (child.type === 'paragraph') {
      const text = serializeInline(child.content);
      if (idx === 0) {
        lines.push(`${indent}${marker} ${text}`);
      } else {
        lines.push(`${indent}  ${text}`);
      }
    } else if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
      lines.push(serializeListBlock(child, indentLevel + 1));
    } else {
      const rendered = serializeBlock(child, indentLevel + 1);
      if (rendered) {
        const prefixed = rendered
          .split('\n')
          .map((l) => (l ? `${indent}  ${l}` : l))
          .join('\n');
        lines.push(prefixed);
      }
    }
  });

  if (lines.length === 0) {
    return `${indent}${marker} `;
  }
  return lines.join('\n');
}

function serializeListBlock(node: TiptapNode, indentLevel = 0): string {
  const items = node.content || [];
  if (node.type === 'taskList') {
    return items
      .map((item) => {
        const mark = item.attrs?.checked ? '[x]' : '[ ]';
        return serializeListItem(item, `- ${mark}`, indentLevel);
      })
      .join('\n');
  }
  if (node.type === 'orderedList') {
    const start = Number(node.attrs?.start ?? 1) || 1;
    return items
      .map((item, idx) => serializeListItem(item, `${start + idx}.`, indentLevel))
      .join('\n');
  }
  return items.map((item) => serializeListItem(item, '-', indentLevel)).join('\n');
}

function serializeCodeBlock(node: TiptapNode): string {
  const lang = typeof node.attrs?.language === 'string' ? node.attrs.language.trim() : '';
  const codeText = (node.content || []).map((c) => c.text || '').join('');
  const backtickRuns = codeText.match(/`+/g) || [];
  const maxRun = backtickRuns.reduce((m, s) => Math.max(m, s.length), 2);
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}${lang}\n${codeText}\n${fence}`;
}

function serializeBlock(node: TiptapNode, indentLevel = 0): string {
  switch (node.type) {
    case 'paragraph':
      return serializeInline(node.content);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      const text = serializeInline(node.content);
      return `${'#'.repeat(level)} ${text}`;
    }
    case 'blockquote': {
      const inner = serializeBlocks(node.content || []);
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'horizontalRule':
      return '---';
    case 'codeBlock':
      return serializeCodeBlock(node);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return serializeListBlock(node, indentLevel);
    case 'table':
      return serializeTable(node);
    case 'image': {
      const src = toCanonicalImageUrl(String(node.attrs?.src || ''));
      const alt = String(node.attrs?.alt || '');
      const title = node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
      return `![${alt}](${src}${title})`;
    }
    default:
      return '';
  }
}

function serializeBlocks(nodes: TiptapNode[]): string {
  if (!nodes || nodes.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const rendered = serializeBlock(nodes[i]);
    if (i === nodes.length - 1 && nodes[i].type === 'paragraph' && rendered === '' && parts.length > 0) {
      continue;
    }
    parts.push(rendered);
  }
  return parts.join('\n\n').trimEnd();
}

/**
 * Serialize a Tiptap JSON doc back into canonical GFM + [[YYYY-MM-DD]] + ==highlight== Markdown.
 */
export function docToMarkdown(doc: TiptapNode | null | undefined): string {
  if (!doc || !Array.isArray(doc.content)) return '';
  // Single empty paragraph -> empty note
  if (
    doc.content.length === 1 &&
    doc.content[0].type === 'paragraph' &&
    (!doc.content[0].content || doc.content[0].content.length === 0)
  ) {
    return '';
  }
  return serializeBlocks(doc.content);
}
