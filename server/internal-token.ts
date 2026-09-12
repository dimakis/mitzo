import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const TOKEN_PATH = join(homedir(), '.mitzo', 'internal-token');
export const TOKEN_LENGTH = 64; // 32 bytes as hex

/** Load existing token from disk or generate a new one.
 *  Persists across restarts so external clients (agents, hooks) stay authenticated.
 *  Accepts an optional path override for testing. */
export function loadOrCreateToken(tokenPath: string = TOKEN_PATH): string {
  try {
    const existing = readFileSync(tokenPath, 'utf-8').trim();
    if (existing.length === TOKEN_LENGTH && /^[0-9a-fA-F]+$/.test(existing)) {
      return existing;
    }
  } catch {
    // File doesn't exist or isn't readable — generate a new one
  }

  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    // Non-fatal — hooks will fall back gracefully
  }
  return token;
}

export const INTERNAL_TOKEN = loadOrCreateToken();

/** Create a credential scoped to one inbound signal callback route. */
export function createSignalCallbackToken(taskId: string): string {
  return createHmac('sha256', INTERNAL_TOKEN).update(`signal-callback:${taskId}`).digest('hex');
}

/** Verify a task-scoped signal credential without exposing the global internal token. */
export function isValidSignalCallbackToken(taskId: string, candidate: string | undefined): boolean {
  if (!candidate || candidate.length !== TOKEN_LENGTH || !/^[0-9a-f]+$/i.test(candidate)) {
    return false;
  }
  const expected = createSignalCallbackToken(taskId);
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

/** Constant-time check for internal token validity. */
export function isValidInternalToken(candidate: string | string[] | undefined): boolean {
  if (!candidate || Array.isArray(candidate)) return false;
  if (candidate.length !== INTERNAL_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(INTERNAL_TOKEN));
}
