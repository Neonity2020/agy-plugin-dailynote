import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../src/db.mjs';
import { createNotesService } from '../src/notes-service.mjs';
import { createTempDataDir } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');

test('dual connections enforce optimistic locking cleanly and preserve snapshots', () => {
  const tmp = createTempDataDir();
  try {
    const sidecarDb = openDatabase({ dataDir: tmp.dir });
    const mcpDb = openDatabase({ dataDir: tmp.dir });

    const sidecarSvc = createNotesService(sidecarDb);
    const mcpSvc = createNotesService(mcpDb);

    // Sidecar creates rev 1
    const s1 = sidecarSvc.saveNote('2026-11-25', {
      content_md: '# 今日任务\n- [ ] 用户正在编写内容',
      expected_revision: 0,
    });
    assert.equal(s1.revision, 1);

    // MCP appends rev 2
    const m1 = mcpSvc.appendNote({
      date: '2026-11-25',
      markdown: '- [ ] Agent 追加待办',
      summary: 'agent append',
    });
    assert.equal(m1.note.revision, 2);

    // Sidecar holding stale rev 1 is rejected with 409 REVISION_CONFLICT
    assert.throws(
      () =>
        sidecarSvc.saveNote('2026-11-25', {
          content_md: '用户未同步修改',
          expected_revision: 1,
        }),
      (err) =>
        err.code === 'REVISION_CONFLICT' &&
        err.status === 409 &&
        err.details.current_revision === 2,
    );

    // MCP toggleTodo with fresh rev 2 succeeds -> rev 3
    const m2 = mcpSvc.toggleTodo({
      date: '2026-11-25',
      expected_revision: 2,
      match_text: 'Agent 追加待办',
      completed: true,
    });
    assert.equal(m2.note.revision, 3);
    assert.equal(m2.note.todo_done, 1);

    sidecarDb.close();
    mcpDb.close();
  } finally {
    tmp.cleanup();
  }
});

test('real cross-process concurrent WAL writers complete without SQLITE_BUSY errors', async () => {
  const tmp = createTempDataDir();
  try {
    const initDb = openDatabase({ dataDir: tmp.dir });
    initDb.close();

    const coreIndexUrl = pathToFileURL(path.join(pkgDir, 'src', 'index.mjs')).href;
    const workerScript = `
      import { openDatabase, createNotesService } from ${JSON.stringify(coreIndexUrl)};
      const workerId = process.env.WORKER_ID;
      const dbCtx = openDatabase({ dataDir: process.env.DAILY_NOTES_DATA_DIR });
      const svc = createNotesService(dbCtx);
      for (let i = 0; i < 8; i++) {
        svc.appendNote({
          date: '2026-11-25',
          markdown: '- worker-' + workerId + '-item-' + i,
          summary: 'worker ' + workerId + ' #' + i,
        });
      }
      dbCtx.close();
    `;

    const spawnWorker = (workerId) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
          env: {
            ...process.env,
            DAILY_NOTES_DATA_DIR: tmp.dir,
            WORKER_ID: String(workerId),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Worker ${workerId} exited with ${code}: ${stderr}`));
        });
      });

    await Promise.all([spawnWorker(1), spawnWorker(2), spawnWorker(3)]);

    const verifyDb = openDatabase({ dataDir: tmp.dir });
    const svc = createNotesService(verifyDb);
    const note = svc.getNote('2026-11-25');
    assert.equal(note.revision, 24);
    for (let w = 1; w <= 3; w++) {
      for (let i = 0; i < 8; i++) {
        assert.ok(note.content_md.includes(`worker-${w}-item-${i}`));
      }
    }
    verifyDb.close();
  } finally {
    tmp.cleanup();
  }
});
