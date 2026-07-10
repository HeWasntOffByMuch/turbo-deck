import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/render',
  // Relative base so the built assets resolve when served from a
  // GitHub Pages project subpath (e.g. /turbo-deck/) as well as root.
  base: './',
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
