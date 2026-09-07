import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Isolated UI fixture: deliberately no API/WebSocket proxy to production.
export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 3102, strictPort: true },
});
