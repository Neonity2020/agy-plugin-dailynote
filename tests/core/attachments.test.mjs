import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_ATTACHMENT_BYTES,
  cleanupOrphanedAttachments,
  detectImageMime,
  getAttachment,
  resolveSafeAttachmentPath,
  saveAttachment,
} from '../../core/attachments.mjs';
import { openDatabase } from '../../core/db.mjs';
import { createNotesService } from '../../core/notes-service.mjs';
import {
  SAMPLE_GIF,
  SAMPLE_JPEG,
  SAMPLE_PNG,
  SAMPLE_SVG,
  SAMPLE_WEBP,
  createTempDataDir,
} from './helpers.mjs';

test('detectImageMime accepts valid raster images and rejects SVG/script payloads', () => {
  assert.equal(detectImageMime(SAMPLE_PNG), 'image/png');
  assert.equal(detectImageMime(SAMPLE_JPEG), 'image/jpeg');
  assert.equal(detectImageMime(SAMPLE_GIF), 'image/gif');
  assert.equal(detectImageMime(SAMPLE_WEBP), 'image/webp');
  assert.equal(detectImageMime(SAMPLE_SVG), null);
  assert.equal(detectImageMime(Buffer.from('<html>')), null);
});

test('saveAttachment works on lazy unsaved date, rejects >10MB and SVG, and enforces path traversal check', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });

    // Upload before note row exists (lazy creation FK safety!)
    const saved = saveAttachment(dbCtx, {
      buffer: SAMPLE_PNG,
      origName: '../evil/../../screen.png',
      noteDate: '2026-11-25',
    });
    assert.ok(saved.id.startsWith('att_'));
    assert.equal(saved.mime_type, 'image/png');
    assert.equal(saved.url, `/api/attachments/${saved.id}`);
    assert.equal(saved.render_url, `/api/attachment?id=${saved.id}`);
    assert.ok(fs.existsSync(path.join(dbCtx.dataDir, saved.rel_path)));

    const loaded = getAttachment(dbCtx, saved.id);
    assert.equal(Buffer.compare(loaded.buffer, SAMPLE_PNG), 0);

    // Reject SVG
    assert.throws(
      () => saveAttachment(dbCtx, { buffer: SAMPLE_SVG, origName: 'xss.svg', noteDate: '2026-11-25' }),
      (err) => err.code === 'UNSUPPORTED_MEDIA_TYPE' && err.status === 415,
    );

    // Reject oversized buffer
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    SAMPLE_PNG.copy(oversized);
    assert.throws(
      () => saveAttachment(dbCtx, { buffer: oversized, origName: 'huge.png', noteDate: '2026-11-25' }),
      (err) => err.code === 'ATTACHMENT_TOO_LARGE' && err.status === 413,
    );

    // Path traversal guard
    assert.throws(
      () => resolveSafeAttachmentPath(dbCtx.attachmentsDir, '../../etc/passwd'),
      (err) => err.code === 'FORBIDDEN_PATH',
    );
    assert.throws(
      () => getAttachment(dbCtx, '../bad'),
      (err) => err.code === 'INVALID_ATTACHMENT_ID',
    );

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});

test('orphan GC preserves attachments referenced by note_revisions and cleans expired orphans after 7 days', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    const service = createNotesService(dbCtx);

    const img = service.saveAttachment({
      buffer: SAMPLE_PNG,
      origName: 'diagram.png',
      noteDate: '2026-11-25',
    });

    // Save note referencing the attachment
    const s1 = service.saveNote('2026-11-25', {
      content_md: `![图](${img.url})`,
      expected_revision: 0,
    });
    assert.equal(s1.revision, 1);

    // Agent overwrites note removing the image (saving pre-write revision snapshot with the image!)
    service.updateNoteControlled({
      date: '2026-11-25',
      expected_revision: 1,
      mode: 'replace',
      markdown: '纯文本替换',
      summary: '移除图片',
    });

    const rowWithSnapshot = dbCtx.adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', img.id);
    assert.equal(rowWithSnapshot.orphaned_at, null, 'Must NOT orphan while revision snapshot still references image');

    // Clear revisions and re-save note to mark image as orphaned
    dbCtx.adapter.run('DELETE FROM note_revisions WHERE note_date = ?', '2026-11-25');
    service.saveNote('2026-11-25', {
      content_md: '依然不含图片',
      expected_revision: 2,
    });

    const rowOrphaned = dbCtx.adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', img.id);
    assert.ok(rowOrphaned.orphaned_at !== null, 'Should mark orphaned_at once no note or revision references it');

    // Cleanup within 6 days should keep file
    const earlyGc = cleanupOrphanedAttachments(dbCtx, {
      maxAgeDays: 7,
      now: new Date(Date.now() + 6 * 86_400_000),
    });
    assert.equal(earlyGc.deletedCount, 0);

    // Cleanup after 8 days should remove both file and DB row
    const absFile = path.join(dbCtx.dataDir, img.rel_path);
    assert.equal(fs.existsSync(absFile), true);
    const expiredGc = cleanupOrphanedAttachments(dbCtx, {
      maxAgeDays: 7,
      now: new Date(Date.now() + 8 * 86_400_000),
    });
    assert.equal(expiredGc.deletedCount, 1);
    assert.equal(fs.existsSync(absFile), false);
    assert.equal(dbCtx.adapter.get('SELECT id FROM attachments WHERE id = ?', img.id), undefined);

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});
