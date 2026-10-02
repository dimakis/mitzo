import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../build-ios.sh', import.meta.url));
const frontend = resolve(dirname(script), '../frontend');

describe('iOS sync entry point', () => {
  it('syncs isolated iOS assets without rebuilding the frontend', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'mitzo-ios-sync-'));
    const log = join(stubDir, 'commands.log');
    try {
      const npx = join(stubDir, 'npx');
      writeFileSync(
        npx,
        '#!/usr/bin/env bash\nprintf "%s|%s|%s\\n" "${CAPACITOR_WEB_DIR:-}" "$PWD" "$*" >> "$IOS_SYNC_TEST_LOG"\n',
      );
      chmodSync(npx, 0o755);

      const npm = join(stubDir, 'npm');
      writeFileSync(npm, '#!/usr/bin/env bash\necho "Unexpected frontend build" >&2\nexit 1\n');
      chmodSync(npm, 0o755);

      const result = spawnSync('bash', [script, '--sync'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          CAPACITOR_WEB_DIR: '',
          IOS_SYNC_TEST_LOG: log,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        `dist-ios|${frontend}|cap sync ios`,
        `|${frontend}|cap open ios`,
      ]);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
