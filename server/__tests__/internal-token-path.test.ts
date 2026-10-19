import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.mocked(readFileSync).mockReturnValue('a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it('uses the explicitly selected private token path for actual internal authentication', async () => {
  const selected = '/synthetic-mitzo-fixture/private/internal-token';
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', selected);
  const owner = await import('../internal-token.js');
  expect(readFileSync).toHaveBeenCalledExactlyOnceWith(selected, 'utf-8');
  expect(owner.isValidInternalToken('a'.repeat(64))).toBe(true);
  expect(owner.isValidInternalToken('b'.repeat(64))).toBe(false);
  expect(writeFileSync).not.toHaveBeenCalled();
});

it('generates and persists only at the selected path when its token is absent', async () => {
  const selected = '/synthetic-mitzo-fixture/private/internal-token';
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', selected);
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error('ENOENT');
  });
  const owner = await import('../internal-token.js');
  expect(readFileSync).toHaveBeenCalledExactlyOnceWith(selected, 'utf-8');
  expect(mkdirSync).toHaveBeenCalledExactlyOnceWith('/synthetic-mitzo-fixture/private', {
    recursive: true,
    mode: 0o700,
  });
  expect(writeFileSync).toHaveBeenCalledExactlyOnceWith(selected, owner.INTERNAL_TOKEN, {
    mode: 0o600,
  });
  expect(owner.isValidInternalToken(owner.INTERNAL_TOKEN)).toBe(true);
});

it.each(['', 'relative/internal-token'])(
  'refuses an invalid selected token path %j before disk access',
  async (selected) => {
    vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', selected);
    await expect(import('../internal-token.js')).rejects.toThrow('absolute');
    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  },
);

it('keeps the established private path when no override was selected', async () => {
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', undefined);
  await import('../internal-token.js');
  expect(readFileSync).toHaveBeenCalledExactlyOnceWith(
    join(homedir(), '.mitzo', 'internal-token'),
    'utf-8',
  );
});
