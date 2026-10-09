import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it.skipIf(process.platform !== 'darwin')(
  'exercises signed-helper rotation with an isolated synthetic Keychain',
  () => {
    const result = spawnSync('/usr/bin/python3', ['scripts/test-keychain-helper.py'], {
      encoding: 'utf8',
      timeout: 90000,
    });
    expect(result.stderr, result.stderr).not.toContain('Traceback');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('disposable-keychain checks passed');
  },
  100000,
);
