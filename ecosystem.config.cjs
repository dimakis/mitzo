/**
 * PM2 process definitions for the local dev stack.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs          # start all
 *   pm2 restart mitzo                        # restart one
 *   pm2 save && pm2 startup                  # persist across reboots
 *
 * Mitzo: Node.js backend serving built frontend + WebSocket.
 * Yapper: Python FastAPI voice service (Whisper STT + Kokoro TTS).
 */
const YAPPER_DIR = '/Users/dsaridak/projects/yapper';

module.exports = {
  apps: [
    {
      name: 'mitzo',
      cwd: __dirname,
      script: 'node',
      args: '--import tsx ./server/index.ts',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10_000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'yapper',
      cwd: YAPPER_DIR,
      script: `${YAPPER_DIR}/.venv/bin/uvicorn`,
      args: 'server:app --host 0.0.0.0 --port 8700',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 10_000,
      merge_logs: true,
      time: true,
      env: {
        PYTORCH_ENABLE_MPS_FALLBACK: '1',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      },
    },
  ],
};
