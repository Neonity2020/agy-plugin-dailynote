import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendMarkdown,
  appendToSectionInMarkdown,
  extractAttachmentIds,
  extractDateLinks,
  extractOpenTodos,
  extractTags,
  formatSingleDayExport,
  normalizeTodoHash,
  parseMarkdownMeta,
  replaceSectionInMarkdown,
  toggleTodoInMarkdown,
} from '../../core/markdown.mjs';

const FIXTURE = [
  '# 标题 #headingtag',
  '',
  '- [ ] 待办 A #perf',
  '- [x] 待办 B',
  '- [X] 待办 C',
  '',
  '```js',
  '- [ ] 代码里的待办 #code',
  '[[2026-02-30]]',
  '```',
  '',
  '行内 `#inline` 与链接 [x](https://example.com/page/#anchor)',
  '双链 [[2026-11-24]] 与非法 [[2026-02-31]]',
  '图片 ![截图](/api/attachments/att_0123456789abcdef01234)',
].join('\n');

test('待办统计忽略围栏代码块', () => {
  const meta = parseMarkdownMeta(FIXTURE);
  assert.equal(meta.todo_total, 3);
  assert.equal(meta.todo_done, 2);
  assert.deepEqual(meta.open_todos, [{ line_number: 3, text: '待办 A #perf' }]);
  assert.deepEqual(extractOpenTodos(FIXTURE).map((item) => item.text), ['待办 A #perf']);
});

test('有序列表任务同样计入', () => {
  const meta = parseMarkdownMeta('1. [ ] 第一步\n2. [x] 第二步');
  assert.equal(meta.todo_total, 2);
  assert.equal(meta.todo_done, 1);
});

test('标签排除代码块、行内代码、URL 锚点与标题符号并小写去重', () => {
  assert.deepEqual(extractTags(FIXTURE), ['headingtag', 'perf']);
  assert.deepEqual(extractTags('#perf 与 #Perf 与 #发布前检查'), ['perf', '发布前检查']);
  assert.deepEqual(extractTags('a#notatag 但（#标签）可以'), ['标签']);
  assert.deepEqual(extractTags('#perf/ #perf-'), ['perf']);
});

test('双链只收合法日历日期且忽略代码', () => {
  assert.deepEqual(extractDateLinks(FIXTURE), ['2026-11-24']);
  assert.deepEqual(extractDateLinks('[[2024-02-29]] [[2026-02-28]]'), ['2024-02-29', '2026-02-28']);
  assert.deepEqual(extractDateLinks('`[[2026-11-24]]`'), []);
});

test('附件引用提取', () => {
  assert.deepEqual(extractAttachmentIds(FIXTURE), ['att_0123456789abcdef01234']);
  assert.deepEqual(extractAttachmentIds('/api/attachments/短id'), []);
});

test('plain_text 剥离标记且中文按字英文按词计数', () => {
  const meta = parseMarkdownMeta(FIXTURE);
  assert.ok(!meta.plain_text.includes('```'));
  assert.ok(!meta.plain_text.includes('#perf'));
  assert.ok(meta.plain_text.includes('待办 A'));
  assert.ok(meta.plain_text.includes('截图'));
  assert.ok(meta.word_count > 10);

  const cjk = parseMarkdownMeta('每日笔记三字');
  assert.equal(cjk.word_count, 6);
  const latin = parseMarkdownMeta('run npm test');
  assert.equal(latin.word_count, 3);
});

test('空正文得到零值元数据', () => {
  const meta = parseMarkdownMeta('');
  assert.deepEqual(
    { plain_text: meta.plain_text, word_count: meta.word_count, todo_total: meta.todo_total, todo_done: meta.todo_done },
    { plain_text: '', word_count: 0, todo_total: 0, todo_done: 0 },
  );
});

test('appendMarkdown 保持段落间隔', () => {
  assert.equal(appendMarkdown('', '  - [ ] a  '), '- [ ] a');
  assert.equal(appendMarkdown('# 标题\n\n正文', '新内容'), '# 标题\n\n正文\n\n新内容');
  assert.equal(appendMarkdown('正文', '   '), '正文');
});

test('toggleTodoInMarkdown 按行号切换完成态', () => {
  const content = '- [ ] 一\n- [ ] 二';
  const done = toggleTodoInMarkdown(content, { line_number: 2, completed: true });
  assert.equal(done.content_md, '- [ ] 一\n- [x] 二');
  assert.equal(done.line_number, 2);

  const undone = toggleTodoInMarkdown(done.content_md, { line_number: 2, completed: false });
  assert.equal(undone.content_md, content);
});

test('toggleTodoInMarkdown 可按文本匹配', () => {
  const content = '- [ ] 部署预发\n- [ ] 补测试';
  const result = toggleTodoInMarkdown(content, { match_text: '补测试', completed: true });
  assert.equal(result.content_md, '- [ ] 部署预发\n- [x] 补测试');
});

test('toggleTodoInMarkdown 不碰代码块内任务行', () => {
  const content = '```md\n- [ ] 假任务\n```\n- [ ] 真任务';
  assert.throws(() => toggleTodoInMarkdown(content, { line_number: 2, completed: true }), /未找到/);

  const result = toggleTodoInMarkdown(content, { line_number: 4, completed: true });
  assert.equal(result.content_md, '```md\n- [ ] 假任务\n```\n- [x] 真任务');
});

test('toggleTodoInMarkdown 找不到时抛 TODO_NOT_FOUND', () => {
  assert.throws(
    () => toggleTodoInMarkdown('- [ ] 甲', { match_text: '乙', completed: true }),
    (error) => error.code === 'TODO_NOT_FOUND',
  );
});

test('replaceSectionInMarkdown 替换小节正文并保留后续小节', () => {
  const content = '## 进展\n\n旧内容\n\n## 待办\n\n- [ ] 旧待办';
  const result = replaceSectionInMarkdown(content, '进展', '新内容');
  assert.equal(result.created, false);
  assert.equal(result.content_md, '## 进展\n\n新内容\n\n## 待办\n\n- [ ] 旧待办');
});

test('replaceSectionInMarkdown 替换到下一个同级标题为止（含子标题）', () => {
  const content = '## 进展\n\n旧\n\n### 细节\n\n细节正文\n\n## 下一步';
  const result = replaceSectionInMarkdown(content, '进展', '新');
  assert.equal(result.content_md, '## 进展\n\n新\n\n## 下一步');
});

test('replaceSectionInMarkdown 小节不存在时文末新建', () => {
  const result = replaceSectionInMarkdown('## 进展\n\n旧', '风险', '暂无');
  assert.equal(result.created, true);
  assert.equal(result.content_md, '## 进展\n\n旧\n\n## 风险\n\n暂无');
});

test('replaceSectionInMarkdown 忽略代码块内的伪标题', () => {
  const content = '```md\n## 进展\n假内容\n```\n\n## 进展\n真内容';
  const result = replaceSectionInMarkdown(content, '进展', '新内容');
  assert.equal(result.content_md, '```md\n## 进展\n假内容\n```\n\n## 进展\n\n新内容');
});

test('appendToSectionInMarkdown 追加到小节末尾并保留后续小节', () => {
  const content = '## 待办\n\n- [ ] 旧的\n\n## 备注\n\n内容';
  const result = appendToSectionInMarkdown(content, '待办', '- [ ] 新的');
  assert.equal(result, '## 待办\n\n- [ ] 旧的\n\n- [ ] 新的\n\n## 备注\n\n内容');
});

test('normalizeTodoHash 对空白差异稳定', () => {
  const a = normalizeTodoHash('- [ ]  部署   预发');
  const b = normalizeTodoHash('部署 预发');
  const c = normalizeTodoHash('部署\n预发');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, normalizeTodoHash('部署生产'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('formatSingleDayExport 生成 GFM 与可选 frontmatter', () => {
  const plain = formatSingleDayExport({ date: '2026-11-25', content_md: '- [ ] 任务' });
  assert.equal(plain, '# 2026-11-25\n\n- [ ] 任务\n');

  const withFrontmatter = formatSingleDayExport({
    date: '2026-11-25',
    content_md: '正文',
    revision: 3,
    tags: ['perf'],
    projects: [{ workspace_uri: 'file:///a', workspace_name: 'A 项目' }],
    frontmatter: true,
  });
  assert.match(withFrontmatter, /^---\ndate: 2026-11-25\nrevision: 3/);
  assert.match(withFrontmatter, /tags: \["perf"\]/);
  assert.match(withFrontmatter, /projects:\n {2}- "A 项目" \(file:\/\/\/a\)/);
  assert.match(withFrontmatter, /\n---\n\n# 2026-11-25\n\n正文\n$/);
});
