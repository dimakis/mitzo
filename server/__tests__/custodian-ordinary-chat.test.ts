import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerMode: true,
  custodianOwnerMode: false,
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('rejects ordinary Codex before host credential preflight when the child has no dedicated sandbox runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'custodian-ordinary-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
  const chat = await import('../chat.js');
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  const launch = vi.spyOn(CodexAppServerClient, 'launch').mockImplementation(() => {
    throw Error('Host fallback reached');
  });
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: '/synthetic/never-read',
        email: 'test@example.test',
        planType: 'plus',
        models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
      },
    ],
    { codexEnabled: true },
  );
  const send = vi.fn();
  try {
    await chat.startChat({ send, isOpen: () => true }, 'ordinary', 'test', {
      cwd: root,
      mode: 'agent',
      accountId: 'personal',
      model: 'gpt-5.6-luna',
      accountProfiles: profiles,
    });
    const { credentials } = await import('../credentials.js');
    const resolve = vi
      .spyOn(credentials, 'resolve')
      .mockRejectedValue(Error('Unexpected host credential lookup'));
    const apiProfiles = new AccountProfiles([
      {
        id: 'api',
        label: 'API',
        provider: 'openai',
        credentialRef: { provider: 'test', service: 'unused', account: 'unused' },
        models: [{ id: 'test-model', label: 'Test' }],
      },
    ]);
    await chat.startChat({ send, isOpen: () => true }, 'api-ordinary', 'test', {
      cwd: root,
      mode: 'agent',
      accountId: 'api',
      model: 'test-model',
      accountProfiles: apiProfiles,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls)).toContain('dedicated OpenShell');
    // The configured path reaches the real runtime owner; stop at its injected
    // provisioning boundary, before any command, credentials or provider call.
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'test-image');
    vi.stubEnv('MITZO_OPENSHELL_POLICY', '/ordinary/policy');
    vi.stubEnv('MITZO_OPENSHELL_SEED', '/ordinary/seed');
    const { OpenShellRuntimeManager } = await import('../openshell-runtime.js');
    const ensure = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
      .mockRejectedValue(Error('Injected ordinary sandbox boundary'));
    const { openCodexChat } = await import('../codex-chat-session.js');
    await expect(
      openCodexChat({
        conversationId: 'configured-ordinary',
        binding: apiProfiles.resolve('api', 'test-model'),
        profile: { planType: 'api', sandboxProvider: 'ordinary-api' },
        session: { cwd: root, mode: 'agent', abortController: new AbortController() },
      } as never),
    ).rejects.toThrow('Injected ordinary sandbox boundary');
    expect(ensure).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
