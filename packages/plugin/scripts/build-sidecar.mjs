import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const entryFile = path.join(rootDir, 'sidecars', 'daily_notes', 'src', 'main.mjs');
const outFile = path.join(rootDir, 'sidecars', 'daily_notes', 'main.mjs');

export async function buildSidecar() {
  await esbuild.build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    sourcemap: false,
    external: ['node:*', 'sidecar_sdk'],
    banner: {
      js: '/* Bundled zero-dependency Sidecar runtime for Daily Notes (@daily-notes/core inlined) */',
    },
    logLevel: 'info',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSidecar().catch((err) => {
    console.error('[build-sidecar] failed:', err);
    process.exit(1);
  });
}
