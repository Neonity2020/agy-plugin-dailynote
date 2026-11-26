import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { dbPathFor } from '../../core/config.mjs';
import { openDatabase } from '../../core/db.mjs';
import { createNotesService } from '../../core/notes-service.mjs';
import { setupService, tempDir } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 在同一数据库文件上打开第二个独立连接（模拟 Sidecar / MCP 双进程各自的持久连接）。
 *
 * @param {import('node:test').TestContext} t
 * @param {string} dataDir
 */
async function secondConnection(t, dataDir) {
  const { adapter } = await openDatabase({ dataDir });
  t.after(() => adapter.close());
  return adapter;
}

/**
 * 以子进程方式运行一段 Node 脚本（真实跨进程访问同一个 SQLite 文件）。
 *
 * @param {string} script
 * @param {string} dbPath
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runNodeChild(script, dbPath, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('适配器事务：嵌套走 SAVEPOINT，内层回滚不波及外层', async (t) => {
  const dataDir = tempDir(t);
  const { adapter } = await openDatabase({ dataDir });

  adapter.transaction(() => {
    adapter.run(
      "INSERT INTO notes (date, content_md, created_at, updated_at) VALUES ('2026-11-25', 'outer', 'x', 'x')",
    );
    assert.throws(
      () =>
        adapter.transaction(() => {
          adapter.run(
            "INSERT INTO notes (date, content_md, created_at, updated_at) VALUES ('2026-11-26', 'inner', 'x', 'x')",
          );
          throw new Error('inner boom');
        }),
      /inner boom/,
    );
    assert.equal(adapter.get("SELECT COUNT(*) AS count FROM notes WHERE date = '2026-11-26'").count, 0);
  });
  assert.equal(adapter.get("SELECT COUNT(*) AS count FROM notes WHERE date = '2026-11-25'").count, 1);

  assert.throws(
    () =>
      adapter.transaction(() => {
        adapter.run(
          "INSERT INTO notes (date, content_md, created_at, updated_at) VALUES ('2026-11-27', 'x', 'x', 'x')",
        );
        throw new Error('outer boom');
      }),
    /outer boom/,
  );
  assert.equal(adapter.get("SELECT COUNT(*) AS count FROM notes WHERE date = '2026-11-27'").count, 0);

  adapter.close();
});

test('双连接并发：WAL 跨连接可见性与乐观锁冲突（Sidecar vs MCP）', async (t) => {
  const { service, dataDir } = await setupService(t);
  const mcpAdapter = await secondConnection(t, dataDir);
  const mcpService = createNotesService({ adapter: mcpAdapter, dataDir });

  // Sidecar 连接创建 rev 1
  const v1 = service.saveNote('2026-11-25', { content_md: '用户初稿', expected_revision: 0 });
  assert.equal(v1.revision, 1);

  // MCP 连接立即可见（WAL 读不阻塞写）
  assert.equal(mcpService.getNoteMeta('2026-11-25').revision, 1);

  // MCP 追加（Agent 通道）→ rev 2 + agent 快照
  const v2 = mcpService.appendNote('2026-11-25', { markdown: 'Agent 补充结论' });
  assert.equal(v2.revision, 2);
  assert.equal(v2.last_editor, 'agent');

  // Sidecar 持旧版本号写入 → REVISION_CONFLICT；重读后按最新 revision 写入成功
  assert.throws(
    () => service.saveNote('2026-11-25', { content_md: '过期写入', expected_revision: 1 }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  const latest = service.getNote('2026-11-25');
  const v3 = service.saveNote('2026-11-25', {
    content_md: `${latest.content_md}\n\n用户补充`,
    expected_revision: latest.revision,
  });
  assert.equal(v3.revision, 3);
  assert.ok(v3.content_md.includes('Agent 补充结论'));

  // FTS 索引跨连接可检索 Agent 写入的内容
  assert.deepEqual(mcpService.searchNotes('补充结论').items.map((item) => item.date), ['2026-11-25']);
});

const BUSY_WAIT_CHILD = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare(
  "INSERT INTO notes (date, content_md, plain_text, revision, last_editor, created_at, updated_at) VALUES ('2026-12-01', '子进程写入', '子进程写入', 1, 'system', 'c', 'u')"
).run();
db.close();
`;

const BUSY_FAIL_CHILD = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 200');
try {
  db.prepare(
    "INSERT INTO notes (date, content_md, plain_text, revision, last_editor, created_at, updated_at) VALUES ('2026-12-02', '不应落库', '不应落库', 1, 'system', 'c', 'u')"
  ).run();
  process.exit(3); // 持锁期间不应写入成功
} catch (error) {
  console.error(String(error.code || ''), error.message);
  process.exit(/BUSY|locked/i.test(String(error.code || '') + ' ' + String(error.message)) ? 0 : 4);
}
`;

test('跨进程写入：busy_timeout 等待父进程提交后成功落库', async (t) => {
  const { adapter, dataDir } = await setupService(t);
  const dbPath = dbPathFor(dataDir);

  adapter.exec('BEGIN IMMEDIATE');
  adapter.run(
    "INSERT INTO notes (date, content_md, plain_text, revision, last_editor, created_at, updated_at) VALUES ('2026-11-25', '父进程持锁', '父进程持锁', 1, 'user', 'c', 'u')",
  );

  const child = runNodeChild(BUSY_WAIT_CHILD, dbPath);
  await sleep(300); // 期间子进程在 busy_timeout 内等待写锁
  adapter.exec('COMMIT');

  const { code, stderr } = await child;
  assert.equal(code, 0, `子进程应等待锁后写入成功：${stderr}`);
  assert.equal(adapter.get("SELECT COUNT(*) AS count FROM notes WHERE date = '2026-12-01'").count, 1);
});

test('跨进程写入：busy_timeout 小于持锁时长时如期收到 SQLITE_BUSY', async (t) => {
  const { adapter, dataDir } = await setupService(t);
  const dbPath = dbPathFor(dataDir);

  adapter.exec('BEGIN IMMEDIATE');
  adapter.run(
    "INSERT INTO notes (date, content_md, plain_text, revision, last_editor, created_at, updated_at) VALUES ('2026-11-25', '父进程持锁', '父进程持锁', 1, 'user', 'c', 'u')",
  );

  const child = runNodeChild(BUSY_FAIL_CHILD, dbPath);
  await sleep(800); // 故意长于子进程的 200ms busy_timeout
  adapter.exec('COMMIT');

  const { code, stderr } = await child;
  assert.equal(code, 0, `子进程应如期收到 SQLITE_BUSY：${stderr}`);
  assert.equal(adapter.get("SELECT COUNT(*) AS count FROM notes WHERE date = '2026-12-02'").count, 0);
});
