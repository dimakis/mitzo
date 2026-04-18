import { randomBytes } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Shared token for MCP server → Mitzo API calls (generated once at startup). */
export const INTERNAL_TOKEN = randomBytes(32).toString('hex');

// Persist to ~/.mitzo/internal-token so session hooks can authenticate
try {
  const dir = join(homedir(), '.mitzo');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'internal-token'), INTERNAL_TOKEN, { mode: 0o600 });
} catch {
  // Non-fatal — hooks will fall back gracefully
}
