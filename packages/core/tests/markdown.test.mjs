import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendMarkdown,
  buildShortSnippet,
  extractMetadata,
  formatExportMarkdown,
  replaceSectionMarkdown,
  toggleTodoLine,
} from '../src/markdown.mjs';

test('extractMetadata accurately derives title, todos, tags, links, attachments, and word count', () => {
  const md = [
    '# 今日架构梳理 #Architecture',
    '',
    '- [x] 完成数据库 Schema #SQLite',
    '- [ ] 联调接口 [[2026-11-24]] 和无效日期 [[2026-02-30]] #发布前检查',
    '',
    '参考 [外部文档](https://example.com/guide#anchor) 与 `#not-a-tag` 以及 [[2026-11-23]]。',
    '',
    '```ts',
    '// #fake-code-tag [[2026-11-20]]',
    '- [ ] code block fake todo',
    '```',
    '',
    '![截图](/api/attachments/att_1234567890ab)',
    '![渲染图](/api/attachment?id=att_abcdef123456)',
  ].join('\n');

  const meta = extractMetadata(md);
  assert.equal(meta.title, '今日架构梳理 #Architecture');
  assert.equal(meta.todo_total, 2);
  assert.equal(meta.todo_done, 1);
  assert.deepEqual(meta.tags, ['architecture', 'sqlite', '发布前检查']);
  assert.deepEqual(meta.links, ['2026-11-24', '2026-11-23']);
  assert.deepEqual(meta.attachment_ids, ['att_1234567890ab', 'att_abcdef123456']);
  assert.ok(meta.word_count > 10);
  assert.ok(!meta.plain_text.includes('https://example.com'));
});

test('appendMarkdown appends at EOF or inside matching heading section', () => {
  const base = '# 今日记录\n\n## 排查结论\n\n- 发现连接池泄漏\n\n## 明日计划\n\n- [ ] 回归验证';

  const appendedSection = appendMarkdown(base, '- 补充 WAL busy_timeout 日志', '排查结论');
  assert.ok(appendedSection.includes('- 发现连接池泄漏\n\n- 补充 WAL busy_timeout 日志\n\n## 明日计划'));

  const appendedNewSection = appendMarkdown(base, '- 新增条目', '全新小节');
  assert.ok(appendedNewSection.endsWith('## 全新小节\n\n- 新增条目'));

  const appendedEof = appendMarkdown(base, '末尾总结', undefined);
  assert.ok(appendedEof.endsWith('## 明日计划\n\n- [ ] 回归验证\n\n末尾总结'));
});

test('replaceSectionMarkdown preserves heading and replaces only target section body', () => {
  const base = '## 一\n旧内容1\n\n### 子标题\n子内容\n\n## 二\n保留内容2';
  const res = replaceSectionMarkdown(base, '一', '新内容1');
  assert.equal(res.found, true);
  assert.equal(res.content_md, '## 一\n\n新内容1\n\n## 二\n保留内容2');

  const missing = replaceSectionMarkdown(base, '不存在', 'x');
  assert.equal(missing.found, false);
});

test('toggleTodoLine toggles by lineNumber or unique matchText and flags ambiguity', () => {
  const md = '- [ ] 写单测\n- [ ] 写单测文档\n- [x] 已完成任务';

  const ambiguous = toggleTodoLine(md, { matchText: '写单测', completed: true });
  // Exact match '写单测' matches line 1 uniquely!
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.line_number, 1);

  const twoMatches = toggleTodoLine('- [ ] 修复 A\n- [ ] 修复 B', {
    matchText: '修复',
    completed: true,
  });
  assert.equal(twoMatches.ok, false);
  assert.equal(twoMatches.errorCode, 'AMBIGUOUS_TODO_MATCH');
  assert.equal(twoMatches.candidates.length, 2);

  const byLine = toggleTodoLine(md, { lineNumber: 2, completed: true });
  assert.equal(byLine.ok, true);
  assert.ok(byLine.content_md.includes('- [x] 写单测文档'));
});

test('buildShortSnippet escapes HTML and wraps matches cleanly', () => {
  const snippet = buildShortSnippet('测试 <script>alert(1)</script> 笔记高亮', '笔记', 32);
  assert.ok(!snippet.includes('<script>'));
  assert.ok(snippet.includes('&lt;script&gt;'));
  assert.ok(snippet.includes('<mark>笔记</mark>'));
});

test('formatExportMarkdown optionally prepends YAML frontmatter', () => {
  const note = {
    date: '2026-11-25',
    revision: 3,
    content_md: '# 标题\n\n正文内容',
    tags: ['perf'],
    projects: [{ workspace_name: 'sidelist', workspace_uri: 'file:///sidelist' }],
    updated_at: '2026-11-25T10:00:00.000Z',
  };

  assert.equal(formatExportMarkdown(note, { frontmatter: false }), '# 标题\n\n正文内容\n');
  const withFm = formatExportMarkdown(note, { frontmatter: true });
  assert.ok(withFm.startsWith('---\ndate: 2026-11-25\nrevision: 3\n'));
  assert.ok(withFm.includes('tags: ["perf"]'));
  assert.ok(withFm.endsWith('# 标题\n\n正文内容\n'));
});
