import { afterEach, expect, it, vi } from 'vitest';
import { runtimeFilesystemSdkBoundary } from '../credential-sdk-boundary.js';
import { createWorkspaceRuntimeCommandRunner } from '../protected-sdk-command.js';

vi.mock('../workspace-runtime-private-paths.js', () => ({
  workspaceRuntimePrivateFiles: () => [],
  workspaceRuntimeAuthorityPaths: () => [],
  workspaceRuntimeSelectorEntries: () => [],
}));
afterEach(() => vi.unstubAllEnvs());
it('preserves unenrolled controller execution even when the host uses Keychain credential isolation', () => {
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9999');
  expect(runtimeFilesystemSdkBoundary()).toBeUndefined();
  expect(createWorkspaceRuntimeCommandRunner()).toBeUndefined();
});
