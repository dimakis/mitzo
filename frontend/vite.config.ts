import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://localhost:3100',
        secure: false,
        changeOrigin: true,
        cookieDomainRewrite: 'localhost',
      },
      '/ws': {
        target: 'wss://localhost:3100',
        ws: true,
        secure: false,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
