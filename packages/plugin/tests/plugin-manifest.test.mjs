import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const ALLOWED_PLUGIN_JSON_KEYS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'logo',
  'suggestedPrompts',
  'author',
  'homepage',
  'repository',
  'disabled',
]);

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relPath), 'utf-8'));
}

test('Antigravity plugin manifests, logo, skills, rules, and build artifacts conform strictly to spec', () => {
  const pluginJson = readJson('plugin.json');
  assert.equal(pluginJson.name, 'daily-notes');
  assert.equal(pluginJson.displayName, 'Daily Notes');
  assert.equal(pluginJson.logo, 'assets/logo.svg');
  assert.ok(Array.isArray(pluginJson.suggestedPrompts) && pluginJson.suggestedPrompts.length === 3);
  for (const key of Object.keys(pluginJson)) {
    assert.ok(ALLOWED_PLUGIN_JSON_KEYS.has(key), `Unexpected top-level field in plugin.json: ${key}`);
  }

  const logoSvg = fs.readFileSync(path.join(rootDir, 'assets', 'logo.svg'), 'utf-8');
  assert.ok(logoSvg.includes('viewBox="0 0 128 128"'));

  const sidecarJson = readJson('sidecars/daily_notes/sidecar.json');
  assert.equal(sidecarJson.command, 'node');
  assert.deepEqual(sidecarJson.args, ['main.mjs']);
  assert.equal(sidecarJson.env?.DAILY_NOTES_DATA_DIR, undefined);
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.agent_permissions?.allows_user_interactions, true);
  assert.equal(sidecarJson.ui_config?.views?.[0]?.entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

  const mcpJson = readJson('mcp_config.json');
  assert.deepEqual(mcpJson.mcpServers?.['daily-notes']?.args, ['${PLUGIN_ROOT}/mcp/server.mjs']);

  assert.equal(mcpJson.mcpServers['daily-notes'].env?.DAILY_NOTES_DATA_DIR, undefined);

  const rulesText = fs.readFileSync(path.join(rootDir, 'rules', 'AGENTS.md'), 'utf-8');
  assert.ok(!rulesText.trimStart().startsWith('---'), 'rules/AGENTS.md must NOT contain YAML frontmatter');

  for (const skillName of ['daily-summary', 'daily-capture']) {
    const skillText = fs.readFileSync(
      path.join(rootDir, 'skills', skillName, 'SKILL.md'),
      'utf-8',
    );
    assert.ok(skillText.startsWith('---\n'), `${skillName}/SKILL.md must have YAML frontmatter`);
    assert.ok(skillText.includes(`name: ${skillName}`));
    assert.ok(skillText.includes('description:'));
  }

  // Built artifacts must exist and use classic non-module assets compatible with Sidecar Aux Pane
  const distIndexPath = path.join(rootDir, 'sidecars', 'daily_notes', 'dist', 'index.html');
  assert.ok(fs.existsSync(distIndexPath));
  assert.ok(fs.existsSync(path.join(rootDir, 'sidecars', 'daily_notes', 'dist', 'app.js')));
  assert.ok(fs.existsSync(path.join(rootDir, 'sidecars', 'daily_notes', 'dist', 'styles.css')));

  const distIndexHtml = fs.readFileSync(distIndexPath, 'utf-8');
  assert.ok(distIndexHtml.includes('<script src="/preload.js"></script>'));
  assert.ok(distIndexHtml.includes('<link rel="stylesheet" href="/styles.css"'));
  assert.ok(distIndexHtml.includes('<script src="/app.js"></script>'));
  assert.ok(!distIndexHtml.includes('type="module"'), 'dist/index.html must not use type="module"');
  assert.ok(!distIndexHtml.includes('crossorigin'), 'dist/index.html must not use crossorigin');

  const sidecarMainPath = path.join(rootDir, 'sidecars', 'daily_notes', 'main.mjs');
  assert.ok(fs.existsSync(sidecarMainPath));
  const sidecarMainText = fs.readFileSync(sidecarMainPath, 'utf-8');
  assert.ok(
    !/from\s+['"](?:[^'"]*\/core\/index\.mjs|@daily-notes\/core)['"]/.test(sidecarMainText),
    'Bundled sidecars/daily_notes/main.mjs must inline @daily-notes/core for standalone install',
  );

  const mcpServerPath = path.join(rootDir, 'mcp', 'server.mjs');
  assert.ok(fs.existsSync(mcpServerPath));
  const mcpServerText = fs.readFileSync(mcpServerPath, 'utf-8');
  assert.ok(
    !/from\s+['"](?:[^'"]*\/core\/index\.mjs|@daily-notes\/core)['"]/.test(mcpServerText),
    'Bundled mcp/server.mjs must inline @daily-notes/core for standalone install',
  );
});
