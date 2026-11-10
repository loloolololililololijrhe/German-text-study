import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths, so the built site works from any folder (GitHub Pages
  // serves it from /<repository-name>/).
  base: './',
  build: { target: 'es2022' },
});
