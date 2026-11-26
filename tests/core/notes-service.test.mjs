import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SNAPSHOT_LIMIT } from '../../core/notes-service.mjs';
import { setupService } from './helpers.mjs';

/** 服务固定在本地时间 2026-11-25 09:30，todayLocal() = '2026-11-25'。 */
const NOW = () => new Date(2026, 10, 25, 9, 30, 0);

async function setup(t) {
  return setupService(t, { now: NOW });
}

test('getNote 惰性读取：不存在的日期返回虚拟空笔记', async (t) => {
  const { service, adapter } = await setup(t);
  const note = service.getNote('2026-11-25');

  assert.equal(note.exists, false);
  assert.equal(note.revision, 0);
  assert.equal(note.content_md, '');
  assert.equal(note.yesterday_pending, null);
  assert.equal(adapter.get('SELECT COUNT(*) AS count FROM notes').count, 0);
});

test('saveNote 创建：revision=1 并同步全部派生数据', async (t) => {
  const { service, adapter } = await setup(t);
  const note = service.saveNote('2026-11-25', {
    content_md: '# 我的日志\n\n今日完成了 #Work 与 #ai 的工作\n链接 [[2026-11-20]] 和非法 [[2026-02-30]]\n\n- [x] 已完成项\n- [ ] 未完成项\n',
    expected_revision: 0,
  });

  assert.equal(note.exists, true);
  assert.equal(note.revision, 1);
  assert.equal(note.last_editor, 'user');
  assert.equal(note.title, '我的日志');
  assert.equal(note.todo_total, 2);
  assert.equal(note.todo_done, 1);
  assert.deepEqual(note.tags, ['ai', 'work']);
  assert.deepEqual(
    adapter.all('SELECT target_date FROM note_links WHERE source_date = ?', '2026-11-25').map((row) => row.target_date),
    ['2026-11-20'],
  );
  assert.ok(note.word_count > 0);
  assert.ok(note.plain_text.includes('今日完成了'));
});

test('saveNote 更新：revision 递增、FTS 可检索新内容', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-25', { content_md: '初版内容', expected_revision: 0 });
  const updated = service.saveNote('2026-11-25', {
    content_md: '这里出现了独特的量子博物馆短语',
    expected_revision: 1,
  });

  assert.equal(updated.revision, 2);
  assert.deepEqual(service.searchNotes('量子博物馆').items.map((item) => item.date), ['2026-11-25']);
});

test('乐观锁：expected_revision 落后抛 REVISION_CONFLICT，force 可强制覆盖', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-25', { content_md: 'v1', expected_revision: 0 });
  service.saveNote('2026-11-25', { content_md: 'v2', expected_revision: 1 });

  let conflict;
  assert.throws(
    () => service.saveNote('2026-11-25', { content_md: '过期写入', expected_revision: 1 }),
    (error) => {
      conflict = error;
      return error.code === 'REVISION_CONFLICT';
    },
  );
  assert.equal(conflict.details.current_revision, 2);
  assert.equal(conflict.details.expected_revision, 1);
  assert.equal(conflict.currentNote.content_md, 'v2');

  assert.equal(service.getNote('2026-11-25').content_md, 'v2');

  const forced = service.saveNote('2026-11-25', { content_md: '强制版本', expected_revision: 1, force: true });
  assert.equal(forced.revision, 3);
  assert.equal(forced.content_md, '强制版本');
});

test('冲突强制覆盖会写入 manual_checkpoint 快照（DATA_MODEL 6.3）', async (t) => {
  const { service, adapter } = await setup(t);
  service.saveNote('2026-11-25', { content_md: '用户手写内容', expected_revision: 0 });

  service.saveNote('2026-11-25', { content_md: '过期强制覆盖', expected_revision: 0, force: true });

  const snapshots = adapter.all('SELECT source, content_md FROM note_revisions WHERE note_date = ? ORDER BY id', '2026-11-25');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].source, 'manual_checkpoint');
  assert.equal(snapshots[0].content_md, '用户手写内容');
});

test('Agent 写入自动快照并记录 last_agent_at', async (t) => {
  const { service, adapter } = await setup(t);
  service.saveNote('2026-11-25', { content_md: '用户原文', expected_revision: 0 });

  const appended = service.appendNote('2026-11-25', { markdown: '\n\n## 会议纪要\n\n讨论了部署方案', summary: '追加会议纪要' });

  assert.equal(appended.last_editor, 'agent');
  assert.ok(appended.last_agent_at);
  assert.ok(appended.content_md.startsWith('用户原文'));
  assert.ok(appended.content_md.includes('## 会议纪要'));

  const snapshot = adapter.get("SELECT * FROM note_revisions WHERE note_date = '2026-11-25'");
  assert.equal(snapshot.source, 'agent');
  assert.equal(snapshot.content_md, '用户原文');
  assert.equal(snapshot.summary, '追加会议纪要');
});

test('appendNote 定向追加到小节末尾，小节不存在时文末新建', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-25', {
    content_md: '# 日志\n\n## 排查记录\n\n已有内容\n\n## 其它\n\n别动我',
    expected_revision: 0,
  });

  const note = service.appendNote('2026-11-25', { markdown: '新结论', heading: '排查记录' });
  const section = note.content_md.split('## 其它')[0];
  assert.ok(section.includes('已有内容'));
  assert.ok(section.includes('新结论'));
  assert.ok(note.content_md.indexOf('新结论') < note.content_md.indexOf('## 其它'));

  const created = service.appendNote('2026-11-25', { markdown: '临时想法', heading: '闪念' });
  assert.ok(created.content_md.includes('## 闪念'));
  assert.ok(created.content_md.trimEnd().endsWith('临时想法'));
});

test('toggleTodo：按文本与行号定点切换，校验乐观锁', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-25', {
    content_md: '- [ ] 任务甲\n- [ ] 任务乙\n',
    expected_revision: 0,
  });

  const toggled = service.toggleTodo('2026-11-25', {
    expected_revision: 1,
    match_text: '任务甲',
    completed: true,
  });
  assert.equal(toggled.toggled_line, 1);
  assert.ok(toggled.content_md.startsWith('- [x] 任务甲'));
  assert.equal(toggled.todo_done, 1);

  const reverted = service.toggleTodo('2026-11-25', {
    expected_revision: 2,
    line_number: 1,
    completed: false,
  });
  assert.ok(reverted.content_md.startsWith('- [ ] 任务甲'));

  assert.throws(
    () => service.toggleTodo('2026-11-25', { expected_revision: 1, match_text: '任务甲', completed: true }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  assert.throws(
    () => service.toggleTodo('2026-11-25', { expected_revision: 3, match_text: '不存在的任务', completed: true }),
    (error) => error.code === 'TODO_NOT_FOUND',
  );
});

test('updateNoteControlled：replace 整篇与 replace_section 保留其余小节', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-25', {
    content_md: '## 纪要\n\n旧内容\n\n## 待办\n\n- [ ] 保持不动\n',
    expected_revision: 0,
  });

  const replaced = service.updateNoteControlled('2026-11-25', {
    expected_revision: 1,
    mode: 'replace_section',
    heading: '纪要',
    markdown: '全新纪要正文',
    summary: '重写纪要小节',
  });
  assert.ok(replaced.content_md.includes('## 纪要'));
  assert.ok(replaced.content_md.includes('全新纪要正文'));
  assert.ok(replaced.content_md.includes('- [ ] 保持不动'));
  assert.ok(!replaced.content_md.includes('旧内容'));

  assert.throws(
    () =>
      service.updateNoteControlled('2026-11-25', {
        expected_revision: 2,
        mode: 'replace_section',
        markdown: 'x',
        summary: 's',
      }),
    (error) => error.code === 'HEADING_REQUIRED',
  );
  assert.throws(
    () =>
      service.updateNoteControlled('2026-11-25', {
        expected_revision: 999,
        mode: 'replace',
        markdown: 'x',
        summary: 's',
      }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
});

test('restoreRevision：恢复快照前自动备份当前版本', async (t) => {
  const { service, adapter } = await setup(t);
  service.saveNote('2026-11-25', { content_md: '原始内容', expected_revision: 0 });
  service.appendNote('2026-11-25', { markdown: '追加内容' });

  const revisions = service.listRevisions('2026-11-25').revisions;
  const original = revisions.find((rev) => rev.content_md_preserved || rev.preview.includes('原始内容'));
  assert.ok(original, '应存在包含原始内容的快照');

  const restored = service.restoreRevision('2026-11-25', original.id, { expected_revision: 2 });
  assert.equal(restored.content_md, '原始内容');
  assert.equal(restored.revision, 3);

  const sources = adapter
    .all('SELECT source FROM note_revisions WHERE note_date = ? ORDER BY id', '2026-11-25')
    .map((row) => row.source);
  assert.ok(sources.includes('restore_backup'));

  assert.throws(
    () => service.restoreRevision('2026-11-25', 9999, { expected_revision: 3 }),
    (error) => error.code === 'REVISION_NOT_FOUND',
  );
});

test('单篇快照保留上限为 50 条', async (t) => {
  const { service, adapter } = await setup(t);
  service.saveNote('2026-11-25', { content_md: '初版', expected_revision: 0 });

  for (let i = 0; i < SNAPSHOT_LIMIT + 10; i += 1) {
    service.appendNote('2026-11-25', { markdown: `第 ${i} 条追加` });
  }

  const count = adapter.get('SELECT COUNT(*) AS count FROM note_revisions WHERE note_date = ?', '2026-11-25').count;
  assert.equal(count, SNAPSHOT_LIMIT);
});

test('searchNotes：FTS 主通道 / LIKE 降级 / 纯过滤三模式', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-20', {
    content_md: '项目评审会议记录 #perf\n进度 50%',
    expected_revision: 0,
  });
  service.saveNote('2026-11-22', { content_md: 'a_b 文件名讨论', expected_revision: 0 });
  service.saveNote('2026-11-24', { content_md: '其它日期的项目评审安排', expected_revision: 0 });

  const fts = service.searchNotes('项目评审');
  assert.equal(fts.mode, 'fts');
  assert.equal(fts.total, 2);
  assert.ok(fts.items.every((item) => item.snippet.includes('<mark>')));

  const like = service.searchNotes('评审', { from: '2026-11-21' });
  assert.equal(like.mode, 'like');
  assert.deepEqual(like.items.map((item) => item.date), ['2026-11-24']);

  const filter = service.searchNotes('', { tag: 'perf' });
  assert.equal(filter.mode, 'filter');
  assert.deepEqual(filter.items.map((item) => item.date), ['2026-11-20']);

  // 1 字符 LIKE 通道验证转义：% 不应变成通配符
  const escaped = service.searchNotes('%');
  assert.equal(escaped.mode, 'like');
  assert.deepEqual(escaped.items.map((item) => item.date), ['2026-11-20']);
});

test('getCalendarMonth：仅非空正文计活跃，支持标签过滤', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-05', { content_md: '有内容的日记 #perf', expected_revision: 0 });
  service.saveNote('2026-11-06', { content_md: '', expected_revision: 0 }); // 空行不算活跃
  service.saveNote('2026-11-07', { content_md: '普通日记', expected_revision: 0 });

  const month = service.getCalendarMonth('2026-11');
  const byDate = new Map(month.days.map((day) => [day.date, day]));
  assert.equal(month.days.length, 30);
  assert.equal(byDate.get('2026-11-05').has_note, true);
  assert.equal(byDate.get('2026-11-06').has_note, false);
  assert.equal(byDate.get('2026-11-25').has_note, false);

  const tagged = service.getCalendarMonth('2026-11', { tag: 'perf' });
  assert.deepEqual(
    tagged.days.filter((day) => day.has_note).map((day) => day.date),
    ['2026-11-05'],
  );
});

test('listTags：按频次排序并支持前缀过滤', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-20', { content_md: '#perf 提速\n#ai 总结', expected_revision: 0 });
  service.saveNote('2026-11-22', { content_md: '#perf 再次优化', expected_revision: 0 });

  const all = service.listTags();
  assert.deepEqual(all.tags, [
    { tag: 'perf', count: 2 },
    { tag: 'ai', count: 1 },
  ]);
  assert.deepEqual(service.listTags({ q: 'a' }).tags.map((row) => row.tag), ['ai']);
});

test('listRange：区间校验与 include_content 切换', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-20', { content_md: '甲日内容', expected_revision: 0 });
  service.saveNote('2026-11-22', { content_md: '乙日内容', expected_revision: 0 });

  const listed = service.listRange('2026-11-19', '2026-11-23');
  assert.deepEqual(listed.items.map((item) => item.date), ['2026-11-22', '2026-11-20']);
  assert.ok(listed.items[0].preview.includes('乙日内容'));
  assert.equal(listed.items[0].content_md, undefined);

  const withContent = service.listRange('2026-11-19', '2026-11-23', { include_content: true });
  assert.equal(withContent.items[0].content_md, '乙日内容');

  assert.throws(
    () => service.listRange('2026-11-23', '2026-11-19'),
    (error) => error.code === 'INVALID_RANGE',
  );
  assert.throws(
    () => service.listRange('2026-01-01', '2026-12-31'),
    (error) => error.code === 'RANGE_TOO_WIDE',
  );
});

test('getOpenTodos：跨日汇总未完成待办', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-23', { content_md: '- [ ] 旧任务\n', expected_revision: 0 });
  service.saveNote('2026-11-24', { content_md: '- [x] 已完成\n- [ ] 新任务\n', expected_revision: 0 });
  service.saveNote('2026-11-10', { content_md: '- [ ] 窗口外任务\n', expected_revision: 0 });

  const todos = service.getOpenTodos({ days: 3 });
  assert.equal(todos.start_date, '2026-11-23');
  assert.equal(todos.end_date, '2026-11-25');
  assert.equal(todos.total, 2);
  assert.deepEqual(
    todos.items.map((item) => `${item.date}:${item.text}`),
    ['2026-11-24:新任务', '2026-11-23:旧任务'],
  );
});

test('待办顺延：提示、幂等 apply 与 dismiss', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-24', {
    content_md: '- [ ] 写周报\n- [x] 晨会\n- [ ] 回复邮件\n',
    expected_revision: 0,
  });

  const pending = service.getNote('2026-11-25').yesterday_pending;
  assert.equal(pending.source_date, '2026-11-24');
  assert.equal(pending.count, 2);
  assert.ok(pending.items.includes('写周报'));

  const applied = service.carryOverTodos('2026-11-25', { action: 'apply' });
  assert.equal(applied.carried_count, 2);
  assert.equal(applied.skipped_count, 0);
  assert.ok(applied.note.content_md.includes('## 待办顺延 (来自 2026-11-24)'));
  assert.ok(applied.note.content_md.includes('- [ ] 写周报'));
  assert.equal(applied.note.carry_over_from, '2026-11-24');
  assert.equal(applied.note.todo_total, 2);

  // 重复 apply 幂等：todo_carryovers 去重
  const again = service.carryOverTodos('2026-11-25', { action: 'apply', source_date: '2026-11-24' });
  assert.equal(again.carried_count, 0);
  assert.equal(again.skipped_count, 2);
  assert.equal(again.note.todo_total, 2);

  // 新的一天：dismiss 后不再提示
  const dismissed = service.carryOverTodos('2026-11-26', { action: 'dismiss' });
  assert.equal(dismissed.carried_count, 0);
  assert.equal(service.getNote('2026-11-26').yesterday_pending, null);
});

test('linkProject：惰性创建锚点行并支持 upsert / 解绑', async (t) => {
  const { service, adapter } = await setup(t);

  const projects = service.linkProject('2026-11-25', {
    workspace_uri: 'file:///repo/agy-plugins',
    workspace_name: 'agy-plugins',
    linked_by: 'agent',
  });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].linked_by, 'agent');
  // 惰性锚点：当日尚无笔记行时创建空行
  assert.ok(adapter.get('SELECT COUNT(*) AS count FROM notes WHERE date = ?', '2026-11-25').count > 0);

  const updated = service.linkProject('2026-11-25', {
    workspace_uri: 'file:///repo/agy-plugins',
    workspace_name: 'AGY Plugins',
  });
  assert.equal(updated[0].workspace_name, 'AGY Plugins');
  assert.equal(updated[0].linked_by, 'user');

  const afterUnlink = service.unlinkProject('2026-11-25', { workspace_uri: 'file:///repo/agy-plugins' });
  assert.deepEqual(afterUnlink, []);
});

test('getNoteMeta：轻量轮询元数据', async (t) => {
  const { service } = await setup(t);
  assert.equal(service.getNoteMeta('2026-11-25').exists, false);

  service.saveNote('2026-11-25', { content_md: '- [ ] 待办\n正文', expected_revision: 0 });
  const meta = service.getNoteMeta('2026-11-25');
  assert.equal(meta.exists, true);
  assert.equal(meta.revision, 1);
  assert.equal(meta.todo_total, 1);
  assert.equal(meta.todo_done, 0);
  assert.ok(meta.updated_at);
});

test('exportNoteMarkdown：标题幂等与 frontmatter', async (t) => {
  const { service } = await setup(t);
  service.saveNote('2026-11-25', { content_md: '# 2026-11-25\n\n正文', expected_revision: 0 });

  const plain = service.exportNoteMarkdown('2026-11-25');
  assert.equal(plain.match(/# 2026-11-25/g)?.length, 1);
  assert.ok(!plain.includes('---'));

  const withMeta = service.exportNoteMarkdown('2026-11-25', { frontmatter: true });
  assert.ok(withMeta.startsWith('---\ndate: 2026-11-25'));
});

test('非法日期与非法修订号抛结构化错误', async (t) => {
  const { service } = await setup(t);
  assert.throws(() => service.getNote('2026-13-01'), (error) => error.code === 'INVALID_DATE');
  assert.throws(() => service.getNote('20260230'), (error) => error.code === 'INVALID_DATE');
  assert.throws(
    () => service.saveNote('2026-11-25', { content_md: 'x', expected_revision: -1 }),
    (error) => error.code === 'INVALID_REVISION',
  );
  assert.throws(
    () => service.appendNote('2026-11-25', { markdown: '   ' }),
    (error) => error.code === 'EMPTY_MARKDOWN',
  );
});
