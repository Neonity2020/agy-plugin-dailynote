import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcp } from './build-mcp.mjs';
import { buildSidecar } from './build-sidecar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function runNodeScript(label, scriptPath, args = []) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

  runNodeScript('TypeScript typecheck', tscBin, ['--noEmit', '-p', 'web/tsconfig.json']);
  runNodeScript('Vite frontend build', viteBin, ['build', '--config', 'web/vite.config.ts']);

  console.log('\n==> Bundling Sidecar Runtime (sidecars/daily_notes/main.mjs)');
  await buildSidecar();

  console.log('\n==> Bundling MCP Server (mcp/server.mjs)');
  await buildMcp();
  console.log('\nBuild completed successfully.');
}

main().catch((err) => {
  console.error('[build-all] failed:', err);
  process.exit(1);
});
