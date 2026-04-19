import { randomBytes } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('internal-token');

/** Shared token for MCP server → Mitzo API calls (generated once at startup). */
export const INTERNAL_TOKEN = randomBytes(32).toString('hex');

// Persist to ~/.mitzo/internal-token so session hooks can authenticate
try {
  const dir = join(homedir(), '.mitzo');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'internal-token'), INTERNAL_TOKEN, { mode: 0o600 });
} catch (err: unknown) {
  log.warn('failed to persist internal token — session hooks will not authenticate', {
    error: err instanceof Error ? err.message : 'unknown',
  });
}
