import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';
import { createWorkspaceRuntimeCommandRunner } from '../protected-sdk-command.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('refuses the enrolled artifact command on Linux before launching any process', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordinary-artifact-platform-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  const executablePath = join(root, 'codex');
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const executableSha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(executablePath, bytes, { mode: 0o755 });
  writeFileSync(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
  const native = join(root, 'native.json'),
    target = join(root, 'target.json');
  writeFileSync(
    native,
    JSON.stringify({
      version: 2,
      executablePath,
      executableSha256,
      codeModeHostSha256: executableSha256,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    target,
    JSON.stringify({
      version: 1,
      targetId: 'offline-platform',
      label: 'Offline platform',
      hostId: hostname(),
      runtimeContractRevision: ordinaryLocalCodexHostContractRevision(
        executableSha256,
        executableSha256,
      ),
    }),
    { mode: 0o600 },
  );
  // Qualify and register the same synthetic native authority selectors as CT09
  // through their real owner, without needing an operator or starting the bytes.
  new OrdinaryLocalCodexHostRuntime({
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: native,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: target,
  });
  const marker = join(root, 'must-not-launch');
  // Exercise the real production factory's unsupported-platform policy. Do not
  // spoof process.platform or substitute an executor for the artifact bridge.
  const run = createWorkspaceRuntimeCommandRunner('linux');
  expect(run).toBeTypeOf('function');
  await expect(
    run!(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      {
        cwd: root,
        env: process.env,
        timeout: 15_000,
      },
    ),
  ).rejects.toThrow('Protected Claude SDK process isolation requires macOS');
  expect(existsSync(marker)).toBe(false);
});
