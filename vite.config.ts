import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/render',
  publicDir: '../../public',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
