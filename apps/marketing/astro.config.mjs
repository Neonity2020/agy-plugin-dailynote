import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://neonity2020.github.io',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'auto',
  },
});
