import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidDateString, nowIso } from './config.mjs';
import { extractMetadata } from './markdown.mjs';

export const ATTACHMENT_ID_RE = /^[a-zA-Z0-9_-]{12,64}$/;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

const MIME_EXT_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Inspect Magic Bytes to detect safe raster image MIME types.
 * Rejects SVG, HTML, scripts, and unknown formats.
 */
export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: GIF87a or GIF89a
  const header6 = buffer.subarray(0, 6).toString('ascii');
  if (header6 === 'GIF87a' || header6 === 'GIF89a') {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function makeSafeOriginName(origName, ext) {
  const base = path.basename(String(origName || `image.${ext}`));
  const sanitized = base.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 120);
  return sanitized || `image.${ext}`;
}

export function resolveSafeAttachmentPath(attachmentsDir, relPath) {
  const root = path.resolve(attachmentsDir);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Object.assign(new Error('Invalid attachment path outside storage root'), {
      code: 'FORBIDDEN_PATH',
      status: 403,
    });
  }
  return resolved;
}

/**
 * Validate and persist an uploaded raster image to attachments/YYYY/MM/ and register metadata in SQLite.
 * Note: If noteDate row does not yet exist (lazy creation), note_date is stored as NULL until the note is saved.
 */
export function saveAttachment(dbCtx, { buffer, origName, noteDate }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('Empty attachment payload'), {
      code: 'INVALID_ATTACHMENT',
      status: 400,
    });
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error(`Attachment exceeds maximum allowed size (${MAX_ATTACHMENT_BYTES} bytes)`), {
      code: 'ATTACHMENT_TOO_LARGE',
      status: 413,
    });
  }
  if (noteDate != null && !isValidDateString(noteDate)) {
    throw Object.assign(new Error(`Invalid note_date: ${noteDate}`), {
      code: 'INVALID_DATE',
      status: 400,
    });
  }

  const mimeType = detectImageMime(buffer);
  if (!mimeType) {
    throw Object.assign(
      new Error('Unsupported image format; only PNG, JPEG, WebP, and GIF are permitted'),
      { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 },
    );
  }

  const ext = MIME_EXT_MAP[mimeType];
  const datePart = noteDate || new Date().toISOString().slice(0, 10);
  const [year, month] = datePart.split('-');
  const randomSuffix = crypto.randomBytes(9).toString('base64url');
  const id = `att_${randomSuffix}`; // 4 + 12 = 16 URL-safe chars
  const relPath = path.posix.join(year, month, `${id}.${ext}`);
  const absPath = resolveSafeAttachmentPath(dbCtx.attachmentsDir, relPath);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, absPath);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = makeSafeOriginName(origName, ext);
  const createdAt = nowIso();

  try {
    dbCtx.adapter.transaction((tx) => {
      let fkNoteDate = null;
      if (noteDate) {
        const existsRow = tx.get('SELECT date FROM notes WHERE date = ?', noteDate);
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
        createdAt,
      );
    });
  } catch (err) {
    try {
      fs.unlinkSync(absPath);
    } catch {
      // Ignore cleanup failure
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
    created_at: createdAt,
  };
}

/**
 * Look up and read a local attachment safely by ID.
 */
export function getAttachment(dbCtx, id) {
  if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) {
    throw Object.assign(new Error('Invalid attachment ID'), {
      code: 'INVALID_ATTACHMENT_ID',
      status: 400,
    });
  }

  const row = dbCtx.adapter.get(
    'SELECT id, note_date, rel_path, orig_name, mime_type, byte_size, sha256, created_at, orphaned_at FROM attachments WHERE id = ?',
    id,
  );
  if (!row) {
    throw Object.assign(new Error('Attachment not found'), {
      code: 'ATTACHMENT_NOT_FOUND',
      status: 404,
    });
  }

  const absPath = resolveSafeAttachmentPath(dbCtx.attachmentsDir, row.rel_path);
  if (!fs.existsSync(absPath)) {
    throw Object.assign(new Error('Attachment file missing on disk'), {
      code: 'ATTACHMENT_NOT_FOUND',
      status: 404,
    });
  }

  return {
    ...row,
    abs_path: absPath,
    buffer: fs.readFileSync(absPath),
  };
}

/**
 * Synchronize attachment ownership & orphan status when a note is saved.
 * Preserves attachments still referenced by the current note, any note_revisions row, or any other note.
 */
export function syncNoteAttachments(tx, noteDate, currentIds, now = nowIso()) {
  const currentSet = new Set(currentIds || []);

  // Re-attach and un-orphan any attachment ID currently referenced by this note
  for (const id of currentSet) {
    if (!ATTACHMENT_ID_RE.test(id)) continue;
    tx.run(
      `UPDATE attachments
       SET orphaned_at = NULL,
           note_date = COALESCE(note_date, ?)
       WHERE id = ?`,
      noteDate,
      id,
    );
  }

  // Collect all attachment IDs still referenced in remaining revisions of this note
  const revRows = tx.all(
    'SELECT content_md FROM note_revisions WHERE note_date = ?',
    noteDate,
  );
  const revisionReferenced = new Set();
  for (const rev of revRows) {
    const meta = extractMetadata(rev.content_md);
    for (const id of meta.attachment_ids) {
      revisionReferenced.add(id);
    }
  }

  // Check attachments belonging to noteDate (or unlinked) that are no longer referenced
  const ownedRows = tx.all(
    'SELECT id, orphaned_at FROM attachments WHERE note_date = ?',
    noteDate,
  );

  for (const row of ownedRows) {
    if (currentSet.has(row.id) || revisionReferenced.has(row.id)) {
      if (row.orphaned_at !== null) {
        tx.run('UPDATE attachments SET orphaned_at = NULL WHERE id = ?', row.id);
      }
      continue;
    }

    // Check if another note happens to reference this attachment ID
    const otherHit = tx.get(
      `SELECT 1 AS found FROM notes
       WHERE date != ?
         AND (content_md LIKE ? OR content_md LIKE ?)
       LIMIT 1`,
      noteDate,
      `%/api/attachments/${row.id}%`,
      `%/api/attachment?id=${row.id}%`,
    );
    if (otherHit) {
      if (row.orphaned_at !== null) {
        tx.run('UPDATE attachments SET orphaned_at = NULL WHERE id = ?', row.id);
      }
      continue;
    }

    if (row.orphaned_at === null) {
      tx.run('UPDATE attachments SET orphaned_at = ? WHERE id = ?', now, row.id);
    }
  }
}

/**
 * Remove orphaned attachments older than maxAgeDays (default 7 days).
 */
export function cleanupOrphanedAttachments(dbCtx, { maxAgeDays = 7, now = new Date() } = {}) {
  const cutoffMs = now.getTime() - maxAgeDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const expired = dbCtx.adapter.all(
    `SELECT id, rel_path FROM attachments
     WHERE orphaned_at IS NOT NULL AND orphaned_at <= ?`,
    cutoffIso,
  );

  let deletedCount = 0;
  for (const item of expired) {
    // Double-check no revision or note still mentions this id before deleting disk file
    const stillReferencedInNote = dbCtx.adapter.get(
      `SELECT 1 AS found FROM notes
       WHERE content_md LIKE ? OR content_md LIKE ?
       LIMIT 1`,
      `%/api/attachments/${item.id}%`,
      `%/api/attachment?id=${item.id}%`,
    );
    const stillReferencedInRev = dbCtx.adapter.get(
      `SELECT 1 AS found FROM note_revisions
       WHERE content_md LIKE ? OR content_md LIKE ?
       LIMIT 1`,
      `%/api/attachments/${item.id}%`,
      `%/api/attachment?id=${item.id}%`,
    );

    if (stillReferencedInNote || stillReferencedInRev) {
      dbCtx.adapter.run('UPDATE attachments SET orphaned_at = NULL WHERE id = ?', item.id);
      continue;
    }

    try {
      const absPath = resolveSafeAttachmentPath(dbCtx.attachmentsDir, item.rel_path);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    } catch {
      // Proceed to remove metadata row even if file was already removed externally
    }

    dbCtx.adapter.run('DELETE FROM attachments WHERE id = ?', item.id);
    deletedCount += 1;
  }

  return { deletedCount };
}
