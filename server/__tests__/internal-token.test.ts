import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** Isolated test of loadOrCreateToken logic without importing the module
 *  (which triggers side-effects). We replicate the function locally. */
const TOKEN_LENGTH = 64;

function loadOrCreateToken(tokenPath: string): string {
  try {
    const existing = readFileSync(tokenPath, 'utf-8').trim();
    if (existing.length === TOKEN_LENGTH && /^[0-9a-fA-F]+$/.test(existing)) {
      return existing;
    }
  } catch {
    // File doesn't exist or isn't readable — generate a new one
  }

  const token = randomBytes(32).toString('hex');
  const dir = tokenPath.substring(0, tokenPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

describe('loadOrCreateToken', () => {
  let testDir: string;
  let tokenPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mitzo-token-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    tokenPath = join(testDir, 'internal-token');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('generates a new token when file is missing', () => {
    const token = loadOrCreateToken(tokenPath);

    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf-8')).toBe(token);
  });

  it('reads existing valid token from disk', () => {
    const existing = 'a'.repeat(TOKEN_LENGTH);
    writeFileSync(tokenPath, existing);

    const token = loadOrCreateToken(tokenPath);

    expect(token).toBe(existing);
  });

  it('accepts uppercase hex tokens', () => {
    const existing = 'A1B2C3D4'.repeat(8); // 64 chars uppercase hex
    writeFileSync(tokenPath, existing);

    const token = loadOrCreateToken(tokenPath);

    expect(token).toBe(existing);
  });

  it('rejects and regenerates on corrupt file (wrong length)', () => {
    writeFileSync(tokenPath, 'too-short');

    const token = loadOrCreateToken(tokenPath);

    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).not.toBe('too-short');
  });

  it('rejects and regenerates on non-hex content', () => {
    const badToken = 'z'.repeat(TOKEN_LENGTH);
    writeFileSync(tokenPath, badToken);

    const token = loadOrCreateToken(tokenPath);

    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).not.toBe(badToken);
  });

  it('trims whitespace from token file', () => {
    const existing = 'b'.repeat(TOKEN_LENGTH);
    writeFileSync(tokenPath, `  ${existing}  \n`);

    const token = loadOrCreateToken(tokenPath);

    expect(token).toBe(existing);
  });

  it('returns consistent token across multiple calls', () => {
    const first = loadOrCreateToken(tokenPath);
    const second = loadOrCreateToken(tokenPath);

    expect(first).toBe(second);
  });
});
