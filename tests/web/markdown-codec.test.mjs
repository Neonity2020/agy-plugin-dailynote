import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { createTempDataDir } from '../core/helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

async function loadMarkdownCodec(tmpDir) {
  const outFile = path.join(tmpDir, 'markdownCodec.mjs');
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'web', 'src', 'lib', 'markdownCodec.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  return import(pathToFileURL(outFile).href);
}

test('markdownCodec preserves semantics across 5 consecutive WYSIWYG <-> Source round-trips', async () => {
  const tmp = createTempDataDir('dn-codec-');
  try {
    const { markdownToDoc, docToMarkdown } = await loadMarkdownCodec(tmp.dir);

    const sampleMarkdown = [
      '# 今日工作日志',
      '',
      '参考 [[2026-11-24]] 的约束，重点处理 **加粗**、*斜体*、~~删除线~~、`inline()` 与 ==重点高亮== #架构。',
      '',
      '- [x] 完成数据库 Schema',
      '- [ ] 验证编辑器双向转换',
      '  - [ ] 嵌套子待办',
      '',
      '> 引用段落内容',
      '',
      '```typescript',
      'const count = 42;',
      'console.log(count);',
      '```',
      '',
      '| 模块 | 状态 | 备注 |',
      '| --- | --- | --- |',
      '| Core | Done | WAL \\| FTS5 |',
      '| Web | WIP | before![cell](/api/attachments/att_1234567890ab)after |',
      '',
      '![架构图](/api/attachments/att_1234567890ab)',
      '',
      '---',
      '',
      '访问 [文档](https://antigravity.google/docs)。',
    ].join('\n');

    const doc1 = markdownToDoc(sampleMarkdown);
    // Verify image URL was mapped for SidecarApp rendering
    const imgNode = doc1.content.find((n) => n.type === 'image');
    assert.ok(imgNode, 'Expected lifted image block node');
    assert.equal(imgNode.attrs.src, '/api/attachment?id=att_1234567890ab');

    // Verify wikilink atom node exists
    const firstPara = doc1.content[1];
    assert.ok(
      firstPara.content.some((n) => n.type === 'dateWikilink' && n.attrs.date === '2026-11-24'),
    );

    let currentMd = sampleMarkdown;
    let firstPassMd = '';
    for (let i = 0; i < 5; i++) {
      const doc = markdownToDoc(currentMd);
      const nextMd = docToMarkdown(doc);
      if (i === 0) firstPassMd = nextMd;
      else assert.equal(nextMd, firstPassMd, `Drift detected at round-trip #${i + 1}`);
      currentMd = nextMd;
    }

    assert.ok(currentMd.includes('before![cell](/api/attachments/att_1234567890ab)after'));
    assert.ok(currentMd.includes('[[2026-11-24]]'));
    assert.ok(currentMd.includes('==重点高亮=='));
    assert.ok(currentMd.includes('- [x] 完成数据库 Schema'));
    assert.ok(currentMd.includes('  - [ ] 嵌套子待办'));
    assert.ok(currentMd.includes('```typescript'));
    assert.ok(currentMd.includes('| Core | Done | WAL \\| FTS5 |'));
    assert.ok(currentMd.includes('![架构图](/api/attachments/att_1234567890ab)'));
  } finally {
    tmp.cleanup();
  }
});

test('markdownCodec strips javascript: XSS links and ignores invalid calendar wikilinks', async () => {
  const tmp = createTempDataDir('dn-codec-sec-');
  try {
    const { markdownToDoc, docToMarkdown, isSafeUrl } = await loadMarkdownCodec(tmp.dir);

    assert.equal(isSafeUrl('https://example.com'), true);
    assert.equal(isSafeUrl('sidecar://daily-notes/'), true);
    assert.equal(isSafeUrl('javascript:alert(1)'), false);
    assert.equal(isSafeUrl('data:text/html,<script>'), false);

    const md = '点击 [危险链接](javascript:alert(1)) 与无效日期 [[2026-02-30]]';
    const doc = markdownToDoc(md);
    const para = doc.content[0];
    assert.equal(
      para.content.some((n) => n.marks?.some((m) => m.type === 'link')),
      false,
    );
    assert.equal(
      para.content.some((n) => n.type === 'dateWikilink'),
      false,
    );
    assert.equal(docToMarkdown(doc), '点击 危险链接 与无效日期 [[2026-02-30]]');
  } finally {
    tmp.cleanup();
  }
});
