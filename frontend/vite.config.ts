import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { productionBundleEvidence } from './production-bundle-evidence.js';

const pdfjsDirectory = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

export default defineConfig({
  plugins: [
    react(),
    ...productionBundleEvidence(),
    viteStaticCopy({
      targets: [
        {
          src: join(pdfjsDirectory, 'build/pdf.worker.min.mjs'),
          dest: 'pdfjs',
          rename: { stripBase: true },
        },
        ...['cmaps', 'standard_fonts', 'wasm'].map((directory) => ({
          src: join(pdfjsDirectory, directory, '*'),
          dest: `pdfjs/${directory}`,
          rename: { stripBase: true as const },
        })),
      ],
    }),
  ],
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
    modulePreload: {
      // WebKit can retain a failed modulepreload across document reloads. Let
      // route imports fetch their JavaScript directly so Try Again can recover.
      // Vite retains route CSS dependencies; keep initial HTML preloads too.
      resolveDependencies: (_filename, dependencies, { hostType }) =>
        hostType === 'js' ? [] : dependencies,
    },
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
