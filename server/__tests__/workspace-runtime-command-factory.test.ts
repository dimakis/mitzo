import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../sandbox-authority.js';
import { runtimeFilesystemSdkBoundary } from '../credential-sdk-boundary.js';
import { createWorkspaceRuntimeCommandRunner } from '../protected-sdk-command.js';

vi.mock('../workspace-runtime-private-paths.js', () => ({
  registerWorkspaceRuntimeAuthorityPaths: vi.fn(),
  workspaceRuntimePrivateFiles: () => [],
  workspaceRuntimeAuthorityPaths: () => [],
  workspaceRuntimeSelectorEntries: () => [],
}));
afterEach(() => vi.unstubAllEnvs());
it('protects Telos without runtime enrollment while preserving the controller network mode', () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9999');
  vi.stubEnv('PATH', '/usr/bin:/bin');
  const boundary = runtimeFilesystemSdkBoundary('darwin');
  expect(boundary).toBeDefined();
  expect(boundary!.credentialIsolation).toBe(false);
  expect(boundary!.deniedRoots).toContain(canonical(join(homedir(), '.mitzo/private/telos')));
  expect(createWorkspaceRuntimeCommandRunner('darwin')).toBeTypeOf('function');
});
