import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createNotesService,
  getLocalDateString,
  openDatabase,
  shiftDateString,
} from '../../core/index.mjs';
import { createTempDataDir } from '../core/helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

function parseToolJson(result) {
  const text = result.content?.[0]?.text || '{}';
  return JSON.parse(text);
}

test('Bundled Stdio MCP Server exposes all 7 tools, enforces optimistic lock, and syncs with SQLite', async () => {
  const tmp = createTempDataDir('dn-mcp-');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(rootDir, 'mcp', 'server.mjs')],
    env: {
      ...process.env,
      DAILY_NOTES_DATA_DIR: tmp.dir,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'daily-notes-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'daily_notes_append',
      'daily_notes_get',
      'daily_notes_get_open_todos',
      'daily_notes_list_range',
      'daily_notes_search',
      'daily_notes_toggle_todo',
      'daily_notes_update',
    ]);

    const today = getLocalDateString();

    // 1. Read empty today
    const getEmpty = parseToolJson(
      await client.callTool({ name: 'daily_notes_get', arguments: { date: today } }),
    );
    assert.equal(getEmpty.exists, false);
    assert.equal(getEmpty.revision, 0);

    // 2. Append new section & todos
    const appended = parseToolJson(
      await client.callTool({
        name: 'daily_notes_append',
        arguments: {
          date: today,
          heading: 'MCP 协同记录',
          markdown: '- [ ] 验证 Stdio MCP 工具 #mcp\n- [ ] 检查 WAL 写入',
          workspace_uri: 'file:///repo/sidelist',
          workspace_name: 'sidelist',
          summary: '添加 MCP 验证任务',
        },
      }),
    );
    assert.equal(appended.ok, true);
    assert.equal(appended.revision, 1);
    assert.ok(appended.snapshot_id > 0);

    // 3. Toggle todo with optimistic lock
    const toggled = parseToolJson(
      await client.callTool({
        name: 'daily_notes_toggle_todo',
        arguments: {
          date: today,
          expected_revision: 1,
          match_text: '验证 Stdio MCP 工具',
          completed: true,
        },
      }),
    );
    assert.equal(toggled.ok, true);
    assert.equal(toggled.revision, 2);

    // 4. Stale expected_revision must fail with REVISION_CONFLICT
    const staleUpdate = await client.callTool({
      name: 'daily_notes_update',
      arguments: {
        date: today,
        expected_revision: 1,
        mode: 'replace',
        markdown: '覆盖内容',
        summary: '错误过期更新',
      },
    });
    assert.equal(staleUpdate.isError, true);
    assert.equal(parseToolJson(staleUpdate).error.code, 'REVISION_CONFLICT');

    // 5. Controlled replace_section with valid rev=2 -> rev=3
    const updated = parseToolJson(
      await client.callTool({
        name: 'daily_notes_update',
        arguments: {
          date: today,
          expected_revision: 2,
          mode: 'replace_section',
          heading: 'MCP 协同记录',
          markdown: '- [x] 验证 Stdio MCP 工具 #mcp\n- [ ] 检查 WAL 写入（已补充）',
          summary: '补充待办描述',
        },
      }),
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.revision, 3);

    // 6. Search, list_range, and get_open_todos
    const searchRes = parseToolJson(
      await client.callTool({
        name: 'daily_notes_search',
        arguments: { query: 'Stdio' },
      }),
    );
    assert.equal(searchRes.total, 1);

    const rangeRes = parseToolJson(
      await client.callTool({
        name: 'daily_notes_list_range',
        arguments: { start_date: today, end_date: today, include_content: true },
      }),
    );
    assert.equal(rangeRes.notes.length, 1);
    assert.ok(rangeRes.notes[0].content_md.includes('已补充'));

    const openTodos = parseToolJson(
      await client.callTool({
        name: 'daily_notes_get_open_todos',
        arguments: { days: 7 },
      }),
    );
    assert.equal(openTodos.total_open, 1);
    assert.ok(openTodos.items[0].text.includes('检查 WAL 写入'));

    // 7. Verify shared SQLite state directly via core/db
    const verifyDb = openDatabase({ dataDir: tmp.dir });
    const revs = verifyDb.adapter.all(
      'SELECT revision, source FROM note_revisions WHERE note_date = ? ORDER BY id ASC',
      today,
    );
    assert.equal(revs.length, 3);
    assert.deepEqual(
      revs.map((r) => r.revision),
      [0, 1, 2],
    );
    verifyDb.close();
  } finally {
    await client.close();
    tmp.cleanup();
  }
});

test('Isolated plugin copy without node_modules boots mcp/server.mjs cleanly', async () => {
  const dataTmp = createTempDataDir('dn-isolated-data-');
  const pluginTmp = createTempDataDir('dn-isolated-plugin-');

  try {
    fs.cpSync(path.join(rootDir, 'core'), path.join(pluginTmp.dir, 'core'), { recursive: true });
    fs.mkdirSync(path.join(pluginTmp.dir, 'mcp'), { recursive: true });
    fs.copyFileSync(
      path.join(rootDir, 'mcp', 'server.mjs'),
      path.join(pluginTmp.dir, 'mcp', 'server.mjs'),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(pluginTmp.dir, 'mcp', 'server.mjs')],
      cwd: pluginTmp.dir,
      env: {
        ...process.env,
        DAILY_NOTES_DATA_DIR: dataTmp.dir,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'isolated-check', version: '1.0.0' });

    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const resources = await client.listResources();
    assert.ok(resources.resources.length >= 4);
    await client.close();
  } finally {
    pluginTmp.cleanup();
    dataTmp.cleanup();
  }
});

test('MCP server exposes Daily Notes resources, templates, completion, and live list_changed notifications', async () => {
  const tmp = createTempDataDir('dn-mcp-res-');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(rootDir, 'mcp', 'server.mjs')],
    env: {
      ...process.env,
      DAILY_NOTES_DATA_DIR: tmp.dir,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'daily-notes-resource-client', version: '1.0.0' });
  let listChangedCount = 0;
  let waiters = [];
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    listChangedCount += 1;
    const currentWaiters = waiters;
    waiters = [];
    for (const resolve of currentWaiters) {
      resolve(listChangedCount);
    }
  });

  function waitForListChanged(previousCount, timeoutMs = 4000) {
    if (listChangedCount > previousCount) {
      return Promise.resolve(listChangedCount);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((fn) => fn !== onNotify);
        reject(new Error(`Timed out waiting for notifications/resources/list_changed (count=${listChangedCount})`));
      }, timeoutMs);
      function onNotify(nextCount) {
        if (nextCount > previousCount) {
          clearTimeout(timer);
          resolve(nextCount);
        } else {
          waiters.push(onNotify);
        }
      }
      waiters.push(onNotify);
    });
  }

  try {
    await client.connect(transport);

    // 1. Initially lists the 4 fixed shortcut resources
    const initialRes = await client.listResources();
    assert.deepEqual(
      initialRes.resources.map((r) => r.uri),
      [
        'daily-notes://today',
        'daily-notes://yesterday',
        'daily-notes://todos/open',
        'daily-notes://recent',
      ],
    );

    // 2. Resource template for per-day lookup
    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((t) => t.uriTemplate),
      ['daily-notes://notes/{date}'],
    );

    // 3. Reading today when DB is empty returns clear metadata + empty-state note
    const emptyToday = await client.readResource({ uri: 'daily-notes://today' });
    assert.equal(emptyToday.contents[0].mimeType, 'text/markdown');
    assert.ok(emptyToday.contents[0].text.includes('revision=0'));
    assert.ok(emptyToday.contents[0].text.includes('暂无内容'));

    const today = getLocalDateString();
    const yesterday = shiftDateString(today, -1);

    // 4. Write yesterday via MCP tool and verify list_changed fires
    const beforeMcpWrite = listChangedCount;
    await client.callTool({
      name: 'daily_notes_append',
      arguments: {
        date: yesterday,
        heading: '昨日回顾',
        markdown: '- [ ] 昨天遗留待办 #followup\n- [x] 昨天已完成',
      },
    });
    await waitForListChanged(beforeMcpWrite);

    // 5. Simulate external Sidecar UI write to SQLite and verify fs.watch triggers list_changed
    const beforeExternalWrite = listChangedCount;
    const sidecarDb = openDatabase({ dataDir: tmp.dir });
    try {
      const sidecarSvc = createNotesService(sidecarDb);
      sidecarSvc.saveNote(today, {
        content_md: '# 今日开发记录\n- [ ] 实现 Composer @ 引用 #feat',
        expected_revision: 0,
      });
    } finally {
      sidecarDb.close();
    }
    await waitForListChanged(beforeExternalWrite);

    // 6. Concrete per-day resources now appear in listResources()
    const populatedRes = await client.listResources();
    const uris = populatedRes.resources.map((r) => r.uri);
    assert.ok(uris.includes(`daily-notes://notes/${today}`));
    assert.ok(uris.includes(`daily-notes://notes/${yesterday}`));
    const todayEntry = populatedRes.resources.find((r) => r.uri === `daily-notes://notes/${today}`);
    assert.ok(todayEntry.title.includes(today));
    assert.ok(todayEntry.description.includes('#feat'));

    // 7. Read all 5 resource flavors
    const todayContent = (await client.readResource({ uri: 'daily-notes://today' })).contents[0].text;
    assert.ok(todayContent.includes('今日开发记录'));
    assert.ok(todayContent.includes('revision=1'));

    const yesterdayContent = (await client.readResource({ uri: 'daily-notes://yesterday' })).contents[0].text;
    assert.ok(yesterdayContent.includes('昨天遗留待办'));

    const specificContent = (
      await client.readResource({ uri: `daily-notes://notes/${today}` })
    ).contents[0].text;
    assert.ok(specificContent.includes('实现 Composer @ 引用'));

    const openTodosContent = (await client.readResource({ uri: 'daily-notes://todos/open' })).contents[0].text;
    assert.ok(openTodosContent.includes('实现 Composer @ 引用'));
    assert.ok(openTodosContent.includes('昨天遗留待办'));
    assert.ok(!openTodosContent.includes('昨天已完成'));

    const recentContent = (await client.readResource({ uri: 'daily-notes://recent' })).contents[0].text;
    assert.ok(recentContent.includes(`daily-notes://notes/${today}`));
    assert.ok(recentContent.includes(`daily-notes://notes/${yesterday}`));

    // 8. Invalid calendar date rejects with MCP error
    await assert.rejects(
      () => client.readResource({ uri: 'daily-notes://notes/2026-02-30' }),
      /日期格式非法|2026-02-30/,
    );

    // 9. Completion for daily-notes://notes/{date}
    const completion = await client.complete({
      ref: { type: 'ref/resource', uri: 'daily-notes://notes/{date}' },
      argument: { name: 'date', value: today.slice(0, 7) },
    });
    assert.ok(completion.completion.values.includes(today));
  } finally {
    await client.close();
    tmp.cleanup();
  }
});
