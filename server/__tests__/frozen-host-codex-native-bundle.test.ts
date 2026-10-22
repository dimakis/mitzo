import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';

// Optional offline native qualification: no credentials, network, model or turn.
// The pinned distribution's helper resolves beside the frozen executable.
it.skipIf(!process.env.MITZO_OFFLINE_NATIVE_BINARY)(
  'loads the real bundled code-mode host from the private frozen runtime',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-native-bundle-')));
    try {
      const home = join(root, 'private');
      mkdirSync(home, { mode: 0o700 });
      const frozen = FrozenHostCodexExecutable.capture(
        process.env.MITZO_OFFLINE_NATIVE_BINARY!,
        home,
      );
      const snapshot = frozen.custodySnapshot();
      expect(snapshot.codeModeHost?.path).toBe(join(home, 'codex-code-mode-host'));
      const result = spawnSync(join(home, 'codex-code-mode-host'), ['--help'], {
        env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root },
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--listen');
      frozen.assertLaunchCurrent();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
