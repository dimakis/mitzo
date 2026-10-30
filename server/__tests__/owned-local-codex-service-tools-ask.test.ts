import { afterAll, expect, it, vi } from 'vitest';
const setup = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-owned-execution-'));
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    MITZO_INTERNAL_TOKEN_PATH: path.join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: path.join(root, 'private'),
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Offline test forbids external network/model calls');
    }),
  );
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
// The integration exercises the existing physical owner and host adapter with
// synthetic executable bytes. The exact-artifact classifier has separate tests;
// kernel fixtures exercise the official bytes without a model call.
vi.mock('../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<typeof import('../codex-native-artifact-qualification.js')>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline test forbids SDK/model calls');
  },
  listSessions: () => [],
}));
import { admittedMacServiceChat } from './fixtures/admitted-mac-service-chat.js';
import { localMacToolServices } from './fixtures/local-mac-tool-services.js';
import { fetchPublicPage } from '../public-web-fetch.js';
import { randomUUID } from 'node:crypto';
vi.mock('../public-web-fetch.js', () => ({
  fetchPublicPage: vi.fn(async () => 'Offline public webpage content'),
}));
import { resolvePending } from '../permissions.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setup.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps service and Knowledge reads available but blocks writes in an admitted Ask chat', async () => {
  const services = await localMacToolServices(setup.root, cleanups);
  const { f, call, approvals, text } = await admittedMacServiceChat(cleanups, 'ask');
  const read = call(
    'ConnectionRequest',
    { connectionId: services.connection.id, path: '/api/states', method: 'GET' },
    'ask-read',
  );
  await vi.waitFor(() => expect(approvals().length).toBeGreaterThan(0), { timeout: 10000 });
  resolvePending(approvals().at(-1)!.permId, 'once', undefined, f.reservation.conversationId);
  expect(await read).toMatchObject({ success: true });
  const dashboard = await call(
    'HomeAssistantDashboard',
    { connectionId: services.connection.id, operation: 'read' },
    'ask-dashboard',
  );
  expect(dashboard).toMatchObject({ success: true });
  const accepted = await call(
    'ReadKnowledge',
    { action: 'read', path: 'people/person.md', revision: services.revision },
    'ask-knowledge',
  );
  expect(accepted).toMatchObject({ success: true });
  expect(text(accepted)).toContain('Original accepted knowledge');
  const beforeFrames = services.frames.length;
  const beforeHttp = services.http.mock.calls.length;
  for (const [tool, args] of [
    [
      'ConnectionRequest',
      {
        connectionId: services.connection.id,
        path: '/api/services/light/turn_on',
        method: 'POST',
        body: '{}',
      },
    ],
    ['ConnectionWebSocket', { connectionId: services.connection.id, message: '{"type":"mutate"}' }],
    [
      'HomeAssistantDashboard',
      {
        connectionId: services.connection.id,
        operation: 'save',
        expectedConfigHash: 'a'.repeat(64),
        config: '{}',
      },
    ],
    [
      'SaveKnowledgeDraft',
      {
        requestId: randomUUID(),
        title: 'Blocked',
        baseRevision: services.revision,
        documents: [{ path: 'people/person.md', content: 'blocked' }],
      },
    ],
    [
      'RequestWebAccess',
      { operation: 'fetch', url: 'https://example.com', reason: 'Blocked in Ask' },
    ],
  ] as Array<[string, Record<string, unknown>]>)
    expect(await call(tool, args, 'ask-block-' + tool)).toMatchObject({ success: false });
  expect(services.frames).toHaveLength(beforeFrames);
  expect(services.http).toHaveBeenCalledTimes(beforeHttp);
  expect(services.drafts.list()).toHaveLength(0);
  expect(fetchPublicPage).not.toHaveBeenCalled();
}, 60000);
