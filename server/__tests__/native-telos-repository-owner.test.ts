import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let close: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-source-custody-')));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '0');
  for (const harness of ['CODEX', 'RESPONSES', 'VERTEX', 'GEMINI'])
    vi.stubEnv(`MITZO_ORDINARY_LOCAL_${harness}_ENABLED`, '0');
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '0');
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('the App source callback reads the real local-only owner without repository enrollment', async () => {
  const runtime = await import('../repository-workspace-runtime.js');
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  const owner = runtime.getLocalRepositoryWorkspaces();
  close = () => owner.closeIdle();
  expect(() => runtime.getRepositoryWorkspaces()).toThrow(
    'Repository-backed chats are not enabled',
  );
  expect(runtime.getRepositoryWorkspaceCustody()).toBe(owner);
  expect(runtime.getRepositoryWorkspaceCustody().getForConversation('absent')).toBeUndefined();

  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '0');
  expect(() => runtime.getLocalRepositoryWorkspaces()).toThrow(
    'Repository-backed chats are not enabled',
  );
  expect(() => runtime.getRepositoryWorkspaces()).toThrow(
    'Repository-backed chats are not enabled',
  );
  expect(runtime.getRepositoryWorkspaceCustody()).toBe(owner);
});

it('source review cannot create custody when no private ledger exists', async () => {
  const runtime = await import('../repository-workspace-runtime.js');
  expect(() => runtime.getRepositoryWorkspaceCustody()).toThrow(
    'Repository preparation state is unavailable',
  );
  expect(existsSync(join(root, 'repository-sources'))).toBe(false);
});

it('source review cannot revive a released custody owner', async () => {
  const runtime = await import('../repository-workspace-runtime.js');
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  runtime.getLocalRepositoryWorkspaces();
  runtime.closeIdleRepositoryWorkspaces();
  expect(() => runtime.getRepositoryWorkspaceCustody()).toThrow(
    'Repository workspace owner released',
  );
});
