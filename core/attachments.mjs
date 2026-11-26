/**
 * 附件落盘、校验与孤儿回收。
 *
 * 规则来源：docs/ARCHITECTURE.md 第 7.2 节、docs/DATA_MODEL.md 第 6.4 节。
 * - 仅允许 png / jpeg / webp / gif（魔数 + MIME 白名单，V1 拒绝 SVG），单文件 <= 10 MB
 * - 附件 ID 限制为 URL 安全字符 `[a-zA-Z0-9_-]{12,64}`，读取时用 path.resolve 前缀校验
 * - 正文删除图片不立即物理删除：先标记 orphaned_at，超过 7 天再回收
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { attachmentsDirFor, toTimestamp } from './config.mjs';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ORPHAN_TTL_DAYS = 7;
export const ATTACHMENT_ID_RE = /^[a-zA-Z0-9_-]{12,64}$/;

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function attachmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @typedef {{ mime: string, ext: string }} Signature
 * @type {readonly { mime: string, ext: string, match: (b: Buffer) => boolean }[]}
 */
const SIGNATURES = Object.freeze([
  {
    mime: 'image/png',
    ext: '.png',
    match: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/jpeg',
    ext: '.jpg',
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/gif',
    ext: '.gif',
    match: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  },
  {
    mime: 'image/webp',
    ext: '.webp',
    match: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
]);

const ALLOWED_MIMES = Object.freeze(SIGNATURES.map((signature) => signature.mime));

/** @returns {string[]} */
export function allowedMimeTypes() {
  return [...ALLOWED_MIMES];
}

/**
 * 按魔数识别图片类型。
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {Signature | null}
 */
export function detectImageType(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  return SIGNATURES.find((signature) => signature.match(buffer)) ?? null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidAttachmentId(value) {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value);
}

/**
 * @param {string} [refresh]
 * @returns {number}
 */
export function daysToMs(days = ORPHAN_TTL_DAYS) {
  return days * 86_400_000;
}

function numeral(value) {
  return String(value).padStart(2, '0');
}

/**
 * @param {Date} now
 * @returns {string} YYYY/MM
 */
function yearMonth(now) {
  return `${now.getFullYear()}/${numeral(now.getMonth() + 1)}`;
}

/**
 * 解析附件文件路径并强制其位于 attachments/ 目录内。
 *
 * rel_path 既接受相对数据目录的 `attachments/YYYY/MM/x.png`，也接受相对
 * attachments/ 的 `YYYY/MM/x.png`。
 *
 * @param {string} dataDir
 * @param {string} relPath
 * @returns {string}
 */
export function resolveAttachmentPath(dataDir, relPath) {
  const dataRoot = path.resolve(dataDir);
  const root = path.resolve(attachmentsDirFor(dataDir));
  const normalized = String(relPath ?? '').split(path.sep).join('/');
  const absolute = normalized.startsWith('attachments/')
    ? path.resolve(dataRoot, normalized)
    : path.resolve(root, normalized);

  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw attachmentError('ATTACHMENT_PATH_ESCAPE', `附件路径越界：${relPath}`);
  }
  return absolute;
}

/**
 * 按 ID 查询并解析磁盘路径（含越界校验与存在性校验）。
 *
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @param {string} dataDir
 * @param {string} id
 * @returns {{ id: string, rel_path: string, absolute_path: string, mime_type: string, note_date: string | null }}
 */
export function resolveStoredAttachment(adapter, dataDir, id) {
  if (!isValidAttachmentId(id)) throw attachmentError('ATTACHMENT_ID_INVALID', `非法附件 ID：${String(id)}`);

  const row = adapter.get('SELECT id, rel_path, mime_type, note_date FROM attachments WHERE id = ?', id);
  if (!row) throw attachmentError('ATTACHMENT_NOT_FOUND', `附件不存在：${id}`);

  const absolute = resolveAttachmentPath(dataDir, row.rel_path);
  if (!existsSync(absolute)) throw attachmentError('ATTACHMENT_NOT_FOUND', `附件文件缺失：${id}`);

  return {
    id: row.id,
    rel_path: row.rel_path,
    absolute_path: absolute,
    mime_type: row.mime_type,
    note_date: row.note_date ?? null,
  };
}

/**
 * 校验并写入一个图片附件。
 *
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @param {{
 *   dataDir: string,
 *   data: Buffer | Uint8Array,
 *   origName?: string,
 *   noteDate?: string | null,
 *   now?: Date,
 * }} input
 * @returns {{ id: string, rel_path: string, mime_type: string, byte_size: number, orig_name: string, url: string, created_at: string }}
 */
export function saveAttachment(adapter, input) {
  const { dataDir } = input;
  const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data ?? []);
  const origName = String(input.origName ?? 'pasted-image');

  if (buffer.byteLength === 0) throw attachmentError('ATTACHMENT_EMPTY', '图片内容为空');
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw attachmentError('ATTACHMENT_TOO_LARGE', `图片超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB 上限`);
  }
  if (/\.svg$/i.test(origName)) {
    throw attachmentError('ATTACHMENT_SVG_UNSUPPORTED', 'V1 不支持直接上传 SVG，请转为 PNG/WebP');
  }

  const signature = detectImageType(buffer);
  if (!signature) {
    throw attachmentError('ATTACHMENT_TYPE_UNSUPPORTED', '仅支持 PNG / JPEG / WebP / GIF 图片');
  }

  const now = input.now ?? new Date();
  const id = `att_${randomBytes(12).toString('hex')}`;
  const relPath = path.posix.join('attachments', yearMonth(now), `${id}${signature.ext}`);
  const absolute = resolveAttachmentPath(dataDir, relPath);
  mkdirSync(path.dirname(absolute), { recursive: true });

  // 先写文件再落库：文件写失败时不留脏元信息
  writeFileSync(absolute, buffer);

  const createdAt = toTimestamp(now);
  try {
    adapter.run(
      `INSERT INTO attachments (id, note_date, rel_path, orig_name, mime_type, byte_size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.noteDate ?? null,
      relPath,
      origName,
      signature.mime,
      buffer.byteLength,
      createHash('sha256').update(buffer).digest('hex'),
      createdAt,
    );
  } catch (error) {
    rmSync(absolute, { force: true });
    throw error;
  }

  return {
    id,
    rel_path: relPath,
    mime_type: signature.mime,
    byte_size: buffer.byteLength,
    orig_name: origName,
    url: `/api/attachments/${id}`,
    created_at: createdAt,
  };
}

/**
 * 读取附件二进制。
 *
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @param {string} dataDir
 * @param {string} id
 * @returns {{ data: Buffer, mime_type: string, rel_path: string, orig_name: string }}
 */
export function readAttachment(adapter, dataDir, id) {
  const resolved = resolveStoredAttachment(adapter, dataDir, id);
  const row = adapter.get('SELECT orig_name FROM attachments WHERE id = ?', id);
  return {
    data: readFileSync(resolved.absolute_path),
    mime_type: resolved.mime_type,
    rel_path: resolved.rel_path,
    orig_name: row?.orig_name ?? 'attachment',
  };
}

/**
 * 快照感知的孤儿标记。
 *
 * 附件仍被当前正文引用 → 清除 orphaned_at；
 * 不再被正文引用但任一历史快照仍引用 → 保留（不清除既有标记之外的额外动作）；
 * 正文与全部快照都不再引用 → 首次打上 orphaned_at。
 *
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @param {{ noteDate: string, attachmentIds?: string[], now?: Date }} input
 * @returns {{ referenced: number, marked: number, revived: number }}
 */
export function reconcileAttachmentOrphans(adapter, input) {
  const { noteDate } = input;
  const now = toTimestamp(input.now ?? new Date());
  const referenced = new Set(input.attachmentIds ?? []);

  for (const id of referenced) {
    adapter.run(
      'UPDATE attachments SET orphaned_at = NULL, note_date = COALESCE(note_date, ?) WHERE id = ?',
      noteDate,
      id,
    );
  }

  const candidates = adapter.all(
    'SELECT id, orphaned_at FROM attachments WHERE note_date = ?',
    noteDate,
  );

  let marked = 0;
  let revived = 0;
  for (const candidate of candidates) {
    if (referenced.has(candidate.id)) continue;

    const inSnapshot = adapter.get(
      "SELECT 1 AS hit FROM note_revisions WHERE note_date = ? AND content_md LIKE '%' || ? || '%' LIMIT 1",
      noteDate,
      `/api/attachments/${candidate.id}`,
    );
    if (inSnapshot) {
      if (candidate.orphaned_at) {
        adapter.run('UPDATE attachments SET orphaned_at = NULL WHERE id = ?', candidate.id);
        revived += 1;
      }
      continue;
    }

    if (!candidate.orphaned_at) {
      adapter.run('UPDATE attachments SET orphaned_at = ? WHERE id = ?', now, candidate.id);
      marked += 1;
    }
  }

  return { referenced: referenced.size, marked, revived };
}

/**
 * 清理孤儿超过保留期的附件（先删文件，再删元信息行）。
 *
 * @param {import('./storage-adapter.mjs').StorageAdapter} adapter
 * @param {{ dataDir: string, now?: Date, ttlDays?: number }} input
 * @returns {{ deleted: number, kept: number, freed_bytes: number }}
 */
export function gcOrphanedAttachments(adapter, input) {
  const ttlDays = input.ttlDays ?? ORPHAN_TTL_DAYS;
  const cutoff = toTimestamp(new Date((input.now ?? new Date()).getTime() - daysToMs(ttlDays)));

  const rows = adapter.all(
    'SELECT id, rel_path, note_date FROM attachments WHERE orphaned_at IS NOT NULL AND orphaned_at <= ?',
    cutoff,
  );

  let deleted = 0;
  let kept = 0;
  let freedBytes = 0;

  for (const row of rows) {
    // 双重保险：只要还有任何历史快照引用就保住文件
    const snapshotHit = row.note_date
      ? adapter.get(
          "SELECT 1 AS hit FROM note_revisions WHERE note_date = ? AND content_md LIKE '%' || ? || '%' LIMIT 1",
          row.note_date,
          `/api/attachments/${row.id}`,
        )
      : adapter.get(
          "SELECT 1 AS hit FROM note_revisions WHERE content_md LIKE '%' || ? || '%' LIMIT 1",
          `/api/attachments/${row.id}`,
        );

    if (snapshotHit) {
      adapter.run('UPDATE attachments SET orphaned_at = NULL WHERE id = ?', row.id);
      kept += 1;
      continue;
    }

    const absolute = resolveAttachmentPath(input.dataDir, row.rel_path);
    const size = adapter.get('SELECT byte_size FROM attachments WHERE id = ?', row.id)?.byte_size ?? 0;
    rmSync(absolute, { force: true });
    adapter.run('DELETE FROM attachments WHERE id = ?', row.id);
    deleted += 1;
    freedBytes += Number(size);
  }

  return { deleted, kept, freed_bytes: freedBytes };
}

