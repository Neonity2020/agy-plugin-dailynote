import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../sidecars/daily_notes/dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
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
