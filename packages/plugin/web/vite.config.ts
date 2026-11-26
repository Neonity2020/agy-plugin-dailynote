import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sidecarClassicHtmlPlugin(): Plugin {
  return {
    name: 'sidecar-classic-html',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        let out = html.replace(
          /<(link|script)\b([^>]*)>/gi,
          (_full, tag, attrs) =>
            `<${tag}${attrs.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi, '')}>`,
        );

        const appScriptRe = /[ \t]*<script\b[^>]*\bsrc=["']\/app\.js["'][^>]*><\/script>\s*\n?/i;
        if (appScriptRe.test(out)) {
          out = out.replace(appScriptRe, '');
          out = out.replace(/<\/body>/i, '    <script src="/app.js"></script>\n  </body>');
        }
        return out;
      },
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [react(), sidecarClassicHtmlPlugin()],
  build: {
    outDir: path.resolve(__dirname, '../sidecars/daily_notes/dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
        name: 'DailyNotesApp',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: (assetInfo) => {
          const fileName = assetInfo.names?.[0] || assetInfo.name || '';
          return fileName.endsWith('.css') ? 'styles.css' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4175',
        changeOrigin: true,
      },
      '/preload.js': {
        target: 'http://127.0.0.1:4175',
        changeOrigin: true,
      },
    },
  },
});
