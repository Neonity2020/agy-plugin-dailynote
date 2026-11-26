import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocalDateString, shiftDateString } from '../../core/config.mjs';
import { openDatabase } from '../../core/db.mjs';
import { createNotesService } from '../../core/notes-service.mjs';
import { createTempDataDir } from './helpers.mjs';

test('lazy creation, optimistic locking 409, forced override backup, and empty-note cleanup', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    const service = createNotesService(dbCtx);

    const empty = service.getNote('2026-11-25');
    assert.equal(empty.exists, false);
    assert.equal(empty.revision, 0);
    assert.equal(dbCtx.adapter.get('SELECT COUNT(*) AS c FROM notes').c, 0);

    // Empty save on nonexistent note stays lazy
    const stillEmpty = service.saveNote('2026-11-25', { content_md: '   ', expected_revision: 0 });
    assert.equal(stillEmpty.exists, false);

    // Real save creates rev 1
    const v1 = service.saveNote('2026-11-25', {
      content_md: '# 笔记\n- [ ] 任务A #backend',
      expected_revision: 0,
    });
    assert.equal(v1.exists, true);
    assert.equal(v1.revision, 1);
    assert.deepEqual(v1.tags, ['backend']);

    // Stale expected_revision throws 409 REVISION_CONFLICT
    assert.throws(
      () => service.saveNote('2026-11-25', { content_md: '覆盖', expected_revision: 0 }),
      (err) => err.code === 'REVISION_CONFLICT' && err.status === 409 && err.details.current_revision === 1,
    );

    // Forced save succeeds and creates restore_backup snapshot
    const v2 = service.saveNote('2026-11-25', {
      content_md: '强制覆盖版',
      expected_revision: 0,
      force: true,
    });
    assert.equal(v2.revision, 2);
    const revs = service.listRevisions('2026-11-25').revisions;
    assert.equal(revs.length, 1);
    assert.equal(revs[0].source, 'restore_backup');
    assert.ok(revs[0].content_md.includes('任务A'));

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});

test('Agent append on empty date creates rev=0 snapshot for one-click undo and prunes snapshots to 50', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    const service = createNotesService(dbCtx);

    const appended = service.appendNote({
      date: '2026-11-25',
      markdown: '- [ ] AI 补充待办',
      heading: '今日待办',
      workspace_uri: 'file:///repo/sidelist',
      workspace_name: 'sidelist',
      summary: '首次记录',
    });
    assert.equal(appended.note.revision, 1);
    assert.equal(appended.note.last_editor, 'agent');
    assert.equal(appended.note.projects.length, 1);

    // Undo restores back to empty content
    const restored = service.restoreRevision('2026-11-25', appended.snapshot_id, {
      expected_revision: 1,
    });
    assert.equal(restored.content_md, '');
    assert.equal(restored.revision, 2);

    // Stress 55 revisions -> retains latest 50
    for (let i = 0; i < 55; i++) {
      service.appendNote({
        date: '2026-11-25',
        markdown: `追加条目 ${i}`,
        summary: `step ${i}`,
      });
    }
    const allRevs = service.listRevisions('2026-11-25', { limit: 100 }).revisions;
    assert.equal(allRevs.length, 50);

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});

test('carryOverTodos is idempotent across repeated invocations and respects dismiss', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    const service = createNotesService(dbCtx);

    const today = getLocalDateString();
    const yesterday = shiftDateString(today, -1);

    service.saveNote(yesterday, {
      content_md: '- [x] 已完成事项\n- [ ] 未完成事项一\n- [ ] 未完成事项二',
      expected_revision: 0,
    });

    const todayBefore = service.getNote(today);
    assert.equal(todayBefore.yesterday_pending.source_date, yesterday);
    assert.equal(todayBefore.yesterday_pending.count, 2);

    const firstCarry = service.carryOverTodos(today, { action: 'apply' });
    assert.equal(firstCarry.carried_count, 2);
    assert.equal(firstCarry.skipped_count, 0);
    assert.equal(firstCarry.note.todo_total, 2);
    assert.equal(firstCarry.note.yesterday_pending, null);

    // Second apply is strictly idempotent
    const secondCarry = service.carryOverTodos(today, { action: 'apply', source_date: yesterday });
    assert.equal(secondCarry.carried_count, 0);
    assert.equal(secondCarry.skipped_count, 2);
    assert.equal(secondCarry.note.todo_total, 2);

    // Dismiss on a fresh day hides pending banner without creating calendar dot
    const tomorrow = shiftDateString(today, 1);
    service.carryOverTodos(tomorrow, { action: 'dismiss' });
    const cal = service.getCalendar({ month: tomorrow.slice(0, 7) });
    const tomorrowCal = cal.days.find((d) => d.date === tomorrow);
    assert.equal(tomorrowCal.has_note, false);

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});

test('3-path search (FTS5 >=3 chars, LIKE 1-2 chars, relational filters), calendar, range, and open todos', () => {
  const tmp = createTempDataDir();
  try {
    const dbCtx = openDatabase({ dataDir: tmp.dir });
    const service = createNotesService(dbCtx);

    service.saveNote('2026-11-23', {
      content_md: '# SQLite 调优\n- [ ] 检查 WAL 模式 #db\n关联 [[2026-11-24]]',
      expected_revision: 0,
    });
    service.linkProject('2026-11-23', {
      workspace_uri: 'file:///ws/alpha',
      workspace_name: 'alpha',
    });

    service.saveNote('2026-11-24', {
      content_md: '# 笔记检索\n学习 SQLite 索引与 AI 协同 #ai',
      expected_revision: 0,
    });

    // Empty anchor row should not appear in calendar or search
    service.linkProject('2026-11-25', {
      workspace_uri: 'file:///ws/alpha',
      workspace_name: 'alpha',
    });

    // FTS5 >= 3 chars
    const ftsZh = service.searchNotes({ q: '每日笔' }); // not present
    assert.equal(ftsZh.total, 0);
    const ftsHit = service.searchNotes({ q: 'SQLite' });
    assert.equal(ftsHit.total, 2);
    assert.ok(ftsHit.items[0].snippet.includes('<mark>SQLite</mark>'));

    // 1-2 char LIKE fallback (Chinese & English)
    const shortZh = service.searchNotes({ q: '笔记' });
    assert.equal(shortZh.total, 1);
    assert.equal(shortZh.items[0].date, '2026-11-24');
    assert.ok(shortZh.items[0].snippet.includes('<mark>笔记</mark>'));

    const shortEn = service.searchNotes({ q: 'AI' });
    assert.equal(shortEn.total, 1);

    // Pure relational filter by project & tag
    const byWs = service.searchNotes({ workspace_uri: 'file:///ws/alpha' });
    assert.equal(byWs.total, 1);
    assert.equal(byWs.items[0].date, '2026-11-23');

    const byTag = service.searchNotes({ tag: '#DB' });
    assert.equal(byTag.total, 1);

    // Calendar ignores empty anchor row 2026-11-25
    const cal = service.getCalendar({ month: '2026-11' });
    assert.equal(cal.days.find((d) => d.date === '2026-11-23').has_note, true);
    assert.equal(cal.days.find((d) => d.date === '2026-11-25').has_note, false);

    // Backlinks on 2026-11-24
    const note24 = service.getNote('2026-11-24');
    assert.equal(note24.backlinks.length, 1);
    assert.equal(note24.backlinks[0].date, '2026-11-23');

    // listRange 90-day cap
    assert.throws(
      () => service.listRange({ start_date: '2026-01-01', end_date: '2026-06-01' }),
      (err) => err.code === 'RANGE_TOO_LARGE',
    );
    const rangeRes = service.listRange({ start_date: '2026-11-20', end_date: '2026-11-25' });
    assert.equal(rangeRes.notes.length, 2);

    // getOpenTodos
    const todosRes = service.getOpenTodos({ start_date: '2026-11-20', end_date: '2026-11-25' });
    assert.equal(todosRes.total_open, 1);
    assert.equal(todosRes.items[0].text, '检查 WAL 模式 #db');

    dbCtx.close();
  } finally {
    tmp.cleanup();
  }
});
