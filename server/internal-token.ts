import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TOKEN_PATH = join(homedir(), '.mitzo', 'internal-token');
const TOKEN_LENGTH = 64; // 32 bytes as hex

/** Load existing token from disk or generate a new one.
 *  Persists across restarts so external clients (agents, hooks) stay authenticated. */
function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(TOKEN_PATH, 'utf-8').trim();
    if (existing.length === TOKEN_LENGTH && /^[0-9a-f]+$/.test(existing)) {
      return existing;
    }
  } catch {
    // File doesn't exist or isn't readable — generate a new one
  }

  const token = randomBytes(32).toString('hex');
  try {
    const dir = join(homedir(), '.mitzo');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  } catch {
    // Non-fatal — hooks will fall back gracefully
  }
  return token;
}

export const INTERNAL_TOKEN = loadOrCreateToken();

/** Constant-time check for internal token validity. */
export function isValidInternalToken(candidate: string | string[] | undefined): boolean {
  if (!candidate || Array.isArray(candidate)) return false;
  if (candidate.length !== INTERNAL_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(INTERNAL_TOKEN));
}
