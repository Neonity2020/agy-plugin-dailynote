import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocalDateString, shiftDateString } from '../../core/config.mjs';
import { startStandaloneServer } from '../../sidecars/daily_notes/main.mjs';
import { SAMPLE_PNG, SAMPLE_SVG, createTempDataDir } from '../core/helpers.mjs';

test('Sidecar HTTP server serves built UI, exact-path routes, RESTful routes, multipart uploads, and 409 conflict', async () => {
  const tmp = createTempDataDir('dn-http-');
  const srv = await startStandaloneServer({ port: 0, dataDir: tmp.dir });

  try {
    // 1. Built dist/index.html + /preload.js
    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('<script src="/preload.js"></script>'));
    assert.ok(html.includes('<div id="root"></div>'));

    const preloadRes = await fetch(`${srv.baseUrl}/preload.js`);
    assert.equal(preloadRes.status, 200);

    const appJsRes = await fetch(`${srv.baseUrl}/app.js`);
    assert.equal(appJsRes.status, 200);
    assert.ok(appJsRes.headers.get('content-type')?.includes('javascript'));
    assert.ok((await appJsRes.text()).length > 0);

    const stylesCssRes = await fetch(`${srv.baseUrl}/styles.css`);
    assert.equal(stylesCssRes.status, 200);
    assert.ok(stylesCssRes.headers.get('content-type')?.includes('text/css'));
    assert.ok((await stylesCssRes.text()).length > 0);

    // 2. Exact-path health & lazy note GET
    const health = await (await fetch(`${srv.baseUrl}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.data.mode, 'standalone');
    assert.equal(health.data.schema_version, 1);

    const today = getLocalDateString();
    const yesterday = shiftDateString(today, -1);

    const emptyNote = await (await fetch(`${srv.baseUrl}/api/note?date=${today}`)).json();
    assert.equal(emptyNote.ok, true);
    assert.equal(emptyNote.data.exists, false);
    assert.equal(emptyNote.data.revision, 0);

    // 3. RESTful PUT on yesterday + carry-over onto today
    const putYesterday = await fetch(`${srv.baseUrl}/api/notes/${yesterday}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content_md: '# 昨日记录\n- [ ] 顺延待办项 #perf',
        expected_revision: 0,
      }),
    });
    assert.equal(putYesterday.status, 200);
    const yesterdayJson = await putYesterday.json();
    assert.equal(yesterdayJson.data.revision, 1);

    const carryRes = await fetch(`${srv.baseUrl}/api/notes/${today}/carry-over`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply' }),
    });
    assert.equal(carryRes.status, 200);
    const carryJson = await carryRes.json();
    assert.equal(carryJson.data.carried_count, 1);
    assert.equal(carryJson.data.note.revision, 1);

    // 4. Exact-path save & 409 conflict
    const saveConflict = await fetch(`${srv.baseUrl}/api/note/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: today,
        content_md: '陈旧版本尝试覆盖',
        expected_revision: 0,
      }),
    });
    assert.equal(saveConflict.status, 409);
    const conflictBody = await saveConflict.json();
    assert.equal(conflictBody.ok, false);
    assert.equal(conflictBody.error.code, 'REVISION_CONFLICT');

    // 5. Base64 upload (SidecarApp exact-path) & binary retrieval
    const base64Upload = await fetch(`${srv.baseUrl}/api/attachment/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note_date: today,
        orig_name: 'paste.png',
        data_base64: `data:image/png;base64,${SAMPLE_PNG.toString('base64')}`,
      }),
    });
    assert.equal(base64Upload.status, 201);
    const img1 = (await base64Upload.json()).data;

    const imgGetExact = await fetch(`${srv.baseUrl}${img1.render_url}`);
    assert.equal(imgGetExact.status, 200);
    assert.equal(imgGetExact.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.compare(Buffer.from(await imgGetExact.arrayBuffer()), SAMPLE_PNG), 0);

    // 6. Multipart upload (RESTful) & SVG rejection
    const form = new FormData();
    form.append('note_date', today);
    form.append('file', new Blob([SAMPLE_PNG], { type: 'image/png' }), 'drop.png');
    const multipartUpload = await fetch(`${srv.baseUrl}/api/attachments`, {
      method: 'POST',
      body: form,
    });
    assert.equal(multipartUpload.status, 201);
    const img2 = (await multipartUpload.json()).data;

    const imgGetRest = await fetch(`${srv.baseUrl}${img2.url}`);
    assert.equal(imgGetRest.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await imgGetRest.arrayBuffer()), SAMPLE_PNG), 0);

    const svgReject = await fetch(`${srv.baseUrl}/api/attachment/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note_date: today,
        orig_name: 'xss.svg',
        data_base64: SAMPLE_SVG.toString('base64'),
      }),
    });
    assert.equal(svgReject.status, 415);

    // 7. Project link/unlink + Search + Export
    const linkRes = await fetch(`${srv.baseUrl}/api/note/projects/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: today,
        workspace_uri: 'file:///repo/sidelist',
        workspace_name: 'sidelist',
      }),
    });
    assert.equal((await linkRes.json()).data.projects.length, 1);

    const searchRes = await (
      await fetch(`${srv.baseUrl}/api/search?q=${encodeURIComponent('顺延')}`)
    ).json();
    assert.equal(searchRes.data.total, 2);

    const exportRes = await fetch(`${srv.baseUrl}/api/notes/${yesterday}/export?frontmatter=1`);
    assert.equal(exportRes.status, 200);
    assert.ok(exportRes.headers.get('content-type')?.includes('text/markdown'));
    const exportText = await exportRes.text();
    assert.ok(exportText.startsWith('---\ndate: '));
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});
