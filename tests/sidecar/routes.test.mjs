import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocalDateString } from '../../core/config.mjs';
import { StandaloneResponse, createSidecarCore } from '../../sidecars/daily_notes/main.mjs';
import { SAMPLE_PNG, createTempDataDir } from '../core/helpers.mjs';

test('createSidecarCore exactRoutes work identically to SidecarApp handler contract', () => {
  const tmp = createTempDataDir('dn-sidecar-routes-');
  const core = createSidecarCore({
    dataDir: tmp.dir,
    mode: 'sidecar_sdk',
    ResponseClass: StandaloneResponse,
  });

  try {
    const today = getLocalDateString();

    const health = core.exactRoutes['GET /api/health']({});
    assert.equal(health.ok, true);
    assert.equal(health.data.mode, 'sidecar_sdk');

    const saved = core.exactRoutes['POST /api/note/save']({
      date: today,
      content_md: '# SidecarApp 路由测试\n- [ ] 项目一 #sidecar',
      expected_revision: 0,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.revision, 1);

    const conflict = core.exactRoutes['POST /api/note/save']({
      date: today,
      content_md: '冲突内容',
      expected_revision: 0,
    });
    assert.ok(conflict instanceof StandaloneResponse);
    assert.equal(conflict.status, 409);
    assert.equal(JSON.parse(conflict.body).error.code, 'REVISION_CONFLICT');

    const upload = core.exactRoutes['POST /api/attachment/upload']({
      note_date: today,
      orig_name: 'shot.png',
      data_base64: SAMPLE_PNG.toString('base64'),
    });
    assert.ok(upload instanceof StandaloneResponse);
    assert.equal(upload.status, 201);
    const uploadedData = JSON.parse(upload.body).data;

    const fetchedImg = core.exactRoutes['GET /api/attachment']({ id: uploadedData.id });
    assert.ok(fetchedImg instanceof StandaloneResponse);
    assert.equal(fetchedImg.status, 200);
    assert.equal(fetchedImg.contentType, 'image/png');
    assert.equal(Buffer.compare(fetchedImg.body, SAMPLE_PNG), 0);

    const exported = core.exactRoutes['GET /api/note/export']({ date: today, frontmatter: '1' });
    assert.ok(exported instanceof StandaloneResponse);
    assert.equal(exported.status, 200);
    assert.ok(exported.body.includes('SidecarApp 路由测试'));
  } finally {
    core.close();
    tmp.cleanup();
  }
});
