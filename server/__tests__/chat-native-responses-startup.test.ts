import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountProfiles } from '../account-profiles.js';
import type { NativeResponsesStore } from '../native-responses-store.js';

const fixture = vi.hoisted(() => ({ stores: [] as NativeResponsesStore[] }));
vi.mock('../native-responses-store.js', async (original) => {
  const actual = await original<typeof import('../native-responses-store.js')>();
  return {
    ...actual,
    NativeResponsesStore: class extends actual.NativeResponsesStore {
      constructor(path: string) {
        super(path);
        fixture.stores.push(this);
      }
    },
  };
});
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: vi.fn(async () => 'offline-fixture-key') },
}));
vi.mock('../codex-mcp-tools.js', () => ({
  connectCodexMcpTools: async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  }),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../native-hooks.js', () => ({
  createNativeHooks: () => ({
    hooks: { run: async () => ({ context: '', forcePrompt: false }) },
    dispose() {},
  }),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../account-session-name.js', () => ({ accountSessionName: vi.fn(async () => null) }));
vi.mock('../account-use-store.js', () => ({ getAccountUseStore: () => ({ record() {} }) }));

afterEach(() => {
  fixture.stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { name: 'initial text', resume: false, image: false },
  { name: 'initial image', resume: false, image: true },
  { name: 'retained text', resume: true, image: false },
  { name: 'retained image', resume: true, image: true },
])(
  'retires unguarded OpenAI $name before credentials, preparation or dispatch',
  async ({ resume, image }) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-retired-startup-'));
    const privateRoot = join(root, 'private');
    await mkdir(privateRoot, { mode: 0o700 });
    await writeFile(join(root, '.mitzo.json'), '{}');
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
    vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
    const profiles = new AccountProfiles([
      {
        id: 'fixture-api',
        label: 'Offline API',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'offline', account: 'fixture' },
        models: [{ id: 'fixture-model', label: 'Fixture' }],
      },
    ]);
    const chat = await import('../chat.js');
    const { credentials } = await import('../credentials.js');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const sourceId = '66666666-6666-4666-8666-666666666666';
    const binding = profiles.resolve('fixture-api', 'fixture-model');
    try {
      if (resume)
        chat.eventStore.upsertSession({
          sessionId: sourceId,
          cwd: root,
          accountBinding: binding,
          selectedModel: binding.model,
          initialPrompt: 'Retained request',
        });
      const transport = { send: vi.fn(), isOpen: () => true };
      await expect(
        chat.startChat(transport, 'client', 'New explicit request', {
          accountId: 'fixture-api',
          model: binding.model,
          accountProfiles: profiles,
          ...(resume ? { resume: sourceId } : {}),
          ...(image ? { images: [{ data: 'cG5n', mediaType: 'image/png' }] } : {}),
          clientMsgId: 'retired-command',
        }),
      ).rejects.toThrow('retired');
      expect(credentials.resolve).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(chat.registry.findBySessionId(sourceId)).toBeNull();
      expect(fixture.stores).toHaveLength(0);
      if (resume)
        expect(chat.eventStore.getSession(sourceId)?.initialPrompt).toBe('Retained request');
    } finally {
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
