import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  ATTACHMENT_ID_RE,
  MAX_ATTACHMENT_BYTES,
  allowedMimeTypes,
  detectImageType,
  gcOrphanedAttachments,
  isValidAttachmentId,
  readAttachment,
  reconcileAttachmentOrphans,
  resolveAttachmentPath,
  resolveStoredAttachment,
  saveAttachment,
} from '../../core/attachments.mjs';
import { gifBytes, jpegBytes, pngBytes, setupService, webpBytes } from './helpers.mjs';

const DATE = '2026-11-25';

test('仅 PNG/JPEG/WebP/GIF 通过魔数白名单', () => {
  assert.deepEqual(allowedMimeTypes(), ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  assert.equal(detectImageType(pngBytes())?.mime, 'image/png');
  assert.equal(detectImageType(jpegBytes())?.mime, 'image/jpeg');
  assert.equal(detectImageType(gifBytes())?.mime, 'image/gif');
  assert.equal(detectImageType(webpBytes())?.mime, 'image/webp');
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('附件 ID 正则限定为 URL 安全字符', () => {
  assert.match('att_0123456789abcdef', ATTACHMENT_ID_RE);
  assert.equal(isValidAttachmentId('att_0123456789abcdef'), true);
  assert.equal(isValidAttachmentId('短'), false);
  assert.equal(isValidAttachmentId('att_0123456789abcdef-XY'), true);
  assert.equal(isValidAttachmentId('../att_0123456789abcdef'), false);
  assert.equal(isValidAttachmentId('a'.repeat(65)), false);
});

test('图片写入 attachments/YYYY/MM 并落库', async (t) => {
  const { service, adapter, dataDir } = await setupService(t);
  service.saveNote(DATE, { content_md: '', expected_revision: 0 });

  const saved = saveAttachment(adapter, {
    dataDir,
    data: pngBytes(),
    origName: '截图.png',
    noteDate: DATE,
    now: new Date(2026, 10, 25, 10, 0),
  });

  assert.match(saved.id, ATTACHMENT_ID_RE);
  assert.equal(saved.mime_type, 'image/png');
  assert.match(saved.rel_path, /^attachments\/2026\/11\/att_[0-9a-f]+\.png$/);
  assert.equal(saved.url, `/api/attachments/${saved.id}`);
  assert.ok(existsSync(path.join(dataDir, saved.rel_path)));

  const row = adapter.get('SELECT * FROM attachments WHERE id = ?', saved.id);
  assert.equal(row.byte_size, pngBytes().byteLength);
  assert.match(row.sha256, /^[0-9a-f]{64}$/);

  const read = readAttachment(adapter, dataDir, saved.id);
  assert.equal(read.mime_type, 'image/png');
  assert.equal(read.data.byteLength, row.byte_size);
});

test('拒绝 SVG / 超限 / 伪图片 / 空内容', async (t) => {
  const { adapter, dataDir } = await setupService(t);

  assert.throws(
    () => saveAttachment(adapter, { dataDir, data: Buffer.from('<svg/>'), origName: 'logo.svg' }),
    (error) => error.code === 'ATTACHMENT_SVG_UNSUPPORTED',
  );
  assert.throws(
    () => saveAttachment(adapter, { dataDir, data: Buffer.from('hello'), origName: 'a.txt' }),
    (error) => error.code === 'ATTACHMENT_TYPE_UNSUPPORTED',
  );
  assert.throws(
    () => saveAttachment(adapter, { dataDir, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), origName: 'big.png' }),
    (error) => error.code === 'ATTACHMENT_TOO_LARGE',
  );
  assert.throws(
    () => saveAttachment(adapter, { dataDir, data: Buffer.alloc(0), origName: 'empty.png' }),
    (error) => error.code === 'ATTACHMENT_EMPTY',
  );
});

test('路径解析阻止穿越出 attachments/', async (t) => {
  const { adapter, dataDir, service } = await setupService(t);
  service.saveNote(DATE, { content_md: '', expected_revision: 0 });

  assert.throws(() => resolveAttachmentPath(dataDir, '../escape.png'), /越界/);
  assert.match(resolveAttachmentPath(dataDir, 'attachments/2026/11/x.png'), /attachments\/2026\/11\/x\.png$/);

  const saved = saveAttachment(adapter, { dataDir, data: pngBytes(), origName: 'a.png', noteDate: DATE });
  adapter.run('UPDATE attachments SET rel_path = ? WHERE id = ?', '../../etc/passwd', saved.id);
  assert.throws(() => resolveStoredAttachment(adapter, dataDir, saved.id), /越界/);
  assert.throws(() => resolveStoredAttachment(adapter, dataDir, '../x'), /非法附件 ID/);
});

test('孤儿标记：正文引用清除标记，正文移除后打标记', async (t) => {
  const { adapter, dataDir, service } = await setupService(t);
  service.saveNote(DATE, { content_md: '', expected_revision: 0 });

  const saved = saveAttachment(adapter, { dataDir, data: pngBytes(), origName: 'a.png', noteDate: DATE });
  const ref = `![a](/api/attachments/${saved.id})`;

  service.saveNote(DATE, { content_md: ref, expected_revision: 1 });
  assert.equal(adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', saved.id).orphaned_at, null);

  service.saveNote(DATE, { content_md: '没有图片了', expected_revision: 2 });
  assert.ok(adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', saved.id).orphaned_at);

  service.saveNote(DATE, { content_md: ref, expected_revision: 3 });
  assert.equal(adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', saved.id).orphaned_at, null);
});

test('历史快照仍引用时 attachment 被保护', async (t) => {
  const { adapter, dataDir, service } = await setupService(t);
  service.saveNote(DATE, { content_md: '', expected_revision: 0 });

  const saved = saveAttachment(adapter, { dataDir, data: pngBytes(), origName: 'a.png', noteDate: DATE });
  const ref = `![a](/api/attachments/${saved.id})`;

  service.saveNote(DATE, { content_md: ref, expected_revision: 1 });
  // Agent 写入会留快照（快照内含旧正文的图片引用）
  service.appendNote(DATE, { markdown: '补充说明' });
  // 用户随后删掉图片
  service.saveNote(DATE, { content_md: '干净正文', expected_revision: 3 });

  const reconciled = reconcileAttachmentOrphans(adapter, {
    noteDate: DATE,
    attachmentIds: [],
    now: new Date(),
  });
  assert.equal(reconciled.marked, 0);
  assert.equal(adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', saved.id).orphaned_at, null);
});

test('GC 仅清理超过 7 天的孤儿并删文件删行', async (t) => {
  const { adapter, dataDir, service } = await setupService(t);
  service.saveNote(DATE, { content_md: '', expected_revision: 0 });

  const saved = saveAttachment(adapter, { dataDir, data: pngBytes(), origName: 'a.png', noteDate: DATE });
  const absolute = path.join(dataDir, saved.rel_path);

  service.saveNote(DATE, { content_md: '无图片', expected_revision: 1 });
  assert.ok(adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', saved.id).orphaned_at);

  const dayMs = 86_400_000;
  const early = gcOrphanedAttachments(adapter, { dataDir, now: new Date(Date.now() + 6 * dayMs) });
  assert.equal(early.deleted, 0);
  assert.ok(existsSync(absolute));

  const later = gcOrphanedAttachments(adapter, { dataDir, now: new Date(Date.now() + 8 * dayMs) });
  assert.equal(later.deleted, 1);
  assert.ok(later.freed_bytes > 0);
  assert.equal(existsSync(absolute), false);
  assert.equal(adapter.get('SELECT COUNT(*) AS count FROM attachments').count, 0);
});

test('GC 遇到快照引用时不删并清除标记', async (t) => {
  const { adapter, dataDir, service } = await setupService(t);
  service.saveNote(DATE, { content_md: '', expected_revision: 0 });

  const saved = saveAttachment(adapter, { dataDir, data: pngBytes(), origName: 'a.png', noteDate: DATE });
  const ref = `![a](/api/attachments/${saved.id})`;

  service.saveNote(DATE, { content_md: ref, expected_revision: 1 });
  service.appendNote(DATE, { markdown: '日志' });
  service.saveNote(DATE, { content_md: '删掉图片', expected_revision: 3 });

  // 手动标记为过期孤儿，模拟快照检查被绕过
  adapter.run('UPDATE attachments SET orphaned_at = ? WHERE id = ?', new Date(0).toISOString(), saved.id);

  const result = gcOrphanedAttachments(adapter, { dataDir, now: new Date() });
  assert.equal(result.deleted, 0);
  assert.equal(result.kept, 1);
  assert.equal(adapter.get('SELECT orphaned_at FROM attachments WHERE id = ?', saved.id).orphaned_at, null);
  assert.ok(existsSync(path.join(dataDir, saved.rel_path)));
});
