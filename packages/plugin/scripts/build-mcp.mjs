import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const entryFile = path.join(rootDir, 'mcp', 'src', 'server.mjs');
const outFile = path.join(rootDir, 'mcp', 'server.mjs');

export async function buildMcp() {
  await esbuild.build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    sourcemap: false,
    external: ['node:*'],
    banner: {
      js: [
        '/* Bundled zero-runtime-dependency Stdio MCP Server for Daily Notes */',
        "import { createRequire as __dnCreateRequire } from 'node:module';",
        'const require = __dnCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'info',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMcp().catch((err) => {
    console.error('[build-mcp] failed:', err);
    process.exit(1);
  });
}
