import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('native subscription bootstrap security (offline)', () => {
  it('passes the filesystem and mocked exec contract checks without invoking Codex', () => {
    const suite = fileURLToPath(
      new URL('../../docs/spikes/openshell-codex/subscription-launcher.test.py', import.meta.url),
    );
    const result = spawnSync('python3', ['-I', '-B', suite], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH },
    });
    expect(
      result.error,
      'Python launcher regression suite must be available in CI',
    ).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('OK');
  });
});
