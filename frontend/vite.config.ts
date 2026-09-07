import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3100',
      '/ws': {
        target: 'ws://localhost:3100',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (
            /\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(path)
          )
            return 'react';
          if (path.includes('/node_modules/highlight.js/')) return 'syntax';
          if (/\/node_modules\/(react-markdown|remark-gfm|rehype-raw|rehype-sanitize)\//.test(path))
            return 'markdown';
          if (path.includes('/node_modules/zod/')) return 'validation';
          if (/\/packages\/(client|protocol)\/dist\//.test(path)) return 'client';
        },
      },
    },
  },
});
