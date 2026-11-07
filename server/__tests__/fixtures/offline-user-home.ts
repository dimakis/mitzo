import { vi } from 'vitest';

export function resetOfflineUserEnvironment() {
  for (const name of [
    'TELOS_DB_PATH',
    'MITZO_TELOS_DATA_DIR',
    'MITZO_CODEX_PRIVATE_DIR',
    'CODEX_HOME',
    'MITZO_KEYCHAIN_HELPER',
    'MITZO_KEYCHAIN_CONNECTIONS_DIR',
    'MITZO_ACCOUNT_PROFILES_FILE',
    'MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE',
    'MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB',
    'MITZO_KNOWLEDGE_LIBRARY_CONFIG',
    'MITZO_WORKSPACE_RUNTIME_CONFIG',
  ])
    vi.stubEnv(name, undefined);
}
resetOfflineUserEnvironment();

// Exercise real privacy guards against synthetic paths, never the developer's
// host credential/configuration directories (which native sandboxes deny).
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  const { join } = await import('node:path');
  return { ...os, homedir: () => join(os.tmpdir(), 'mitzo-offline-user-home') };
});
