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
import { setCredentialConnectionsRuntime } from '../credential-connections-runtime.js';
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

it('uses Keychain, Home Assistant, Knowledge and web tools through an admitted Local Mac chat', async () => {
  const services = await localMacToolServices(setup.root, cleanups);
  const { f, chat, transport, names, call, approvals, approve, text } =
    await admittedMacServiceChat(cleanups, 'agent');
  for (const name of [
    'ListConnections',
    'ConnectionRequest',
    'HomeAssistantDashboard',
    'ConnectionWebSocket',
    'ReadKnowledge',
    'SaveKnowledgeDraft',
    'RequestWebAccess',
  ])
    expect(names).toContain(name);
  const catalog = await call('ListConnections', {}, 'connections');
  expect(text(catalog)).toContain('Offline Home Assistant');
  expect(services.vault.read).not.toHaveBeenCalled();
  const setupResult = await call(
    'PrepareConnectionSetup',
    { profile: 'home-assistant', endpoint: 'https://second-ha.example.test' },
    'setup',
  );
  expect(setupResult).toMatchObject({ success: true });
  const setupId = JSON.parse(text(setupResult)).setup.id;
  const setupStatus = await call('GetConnectionSetup', { setupId }, 'setup-status');
  expect(text(setupStatus)).toContain('pending');
  expect(services.vault.read).not.toHaveBeenCalled();
  const beforeConsent = approvals().length;
  const grant = vi.spyOn(services.service, 'grant');
  const firstAccess = call(
    'RequestConnectionAccess',
    { connectionId: services.connection.id },
    'grant',
  );
  const secondAccess = call(
    'RequestConnectionAccess',
    { connectionId: services.connection.id },
    'grant-coalesced',
  );
  const connected = await approve(firstAccess, beforeConsent);
  expect(await secondAccess).toMatchObject({ success: true });
  expect(connected).toMatchObject({ success: true });
  expect(approvals().length - beforeConsent).toBe(1);
  expect(grant).toHaveBeenCalledOnce();
  const response = await call(
    'ConnectionRequest',
    { connectionId: services.connection.id, path: '/api/states', method: 'GET' },
    'http',
  );
  expect(response).toMatchObject({ success: true });
  expect(text(response)).toContain('light.study');
  expect(text(response)).not.toContain('SECRET');
  const read = await call(
    'HomeAssistantDashboard',
    { connectionId: services.connection.id, operation: 'read' },
    'ha-read',
  );
  expect(read).toMatchObject({ success: true });
  const baseline = JSON.parse(text(read));
  expect(baseline.config.views[0].title).toBe('Home');
  const save = await call(
    'HomeAssistantDashboard',
    {
      connectionId: services.connection.id,
      operation: 'save',
      expectedConfigHash: baseline.configHash,
      config: JSON.stringify({ views: [{ title: 'Changed', cards: [] }] }),
    },
    'ha-save',
  );
  expect(save).toMatchObject({ success: true });
  expect(JSON.parse(text(save)).verified).toBe(true);
  const ws = await call(
    'ConnectionWebSocket',
    { connectionId: services.connection.id, message: '{"id":10,"type":"ping"}' },
    'ws',
  );
  expect(ws).toMatchObject({ success: true });
  const knowledge = await call('ReadKnowledge', { action: 'list' }, 'knowledge-list');
  expect(text(knowledge)).toContain('people/person.md');
  const accepted = await call(
    'ReadKnowledge',
    { action: 'read', path: 'people/person.md', revision: services.revision },
    'knowledge-read',
  );
  expect(text(accepted)).toContain('Original accepted knowledge');
  expect(text(accepted)).not.toContain('Dirty task');
  const draftInput = {
    requestId: randomUUID(),
    title: 'Proposed profile',
    baseRevision: services.revision,
    documents: [{ path: 'people/person.md', content: '# Updated accepted profile proposal\n' }],
  };
  const draft = await approve(call('SaveKnowledgeDraft', draftInput, 'draft'), approvals().length);
  expect(draft).toMatchObject({ success: true });
  expect(JSON.parse(text(draft)).status).toBe('draft-saved');
  expect(services.drafts.list()).toHaveLength(1);
  const same = await approve(
    call('SaveKnowledgeDraft', draftInput, 'draft-retry'),
    approvals().length,
  );
  expect(text(same)).toBe(text(draft));
  expect(services.drafts.list()).toHaveLength(1);
  const page = await approve(
    call(
      'RequestWebAccess',
      { operation: 'fetch', url: 'https://example.com', reason: 'Read reference' },
      'web',
    ),
    approvals().length,
  );
  expect(page).toMatchObject({ success: true });
  expect(text(page)).toContain('Offline public webpage content');
  expect(fetchPublicPage).toHaveBeenCalledOnce();
  const frameStart = services.frames.length;
  services.setBeforeFrame(() => {
    if (services.frames.at(-1)?.type === 'auth')
      services.service.revokeSession(f.reservation.conversationId, services.connection.id);
  });
  const revokedFrame = await call(
    'HomeAssistantDashboard',
    { connectionId: services.connection.id, operation: 'read' },
    'ha-revoked-frame',
  );
  expect(revokedFrame).toMatchObject({ success: false });
  expect(services.frames.slice(frameStart).some((frame) => frame.type === 'lovelace/config')).toBe(
    false,
  );
  services.setBeforeFrame(undefined);
  services.service.revokeSession(f.reservation.conversationId, services.connection.id);
  const count = services.http.mock.calls.length;
  const denied = await approve(
    call(
      'ConnectionRequest',
      { connectionId: services.connection.id, path: '/api/states', method: 'GET' },
      'denied',
    ),
    approvals().length,
    'deny',
  );
  expect(denied).toMatchObject({ success: false });
  expect(services.http).toHaveBeenCalledTimes(count);
  const session = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
  session.activeSkillPolicy = new Set(['ReadKnowledge']);
  const ceiling = await call(
    'ConnectionRequest',
    { connectionId: services.connection.id, path: '/api/states', method: 'GET' },
    'ceiling',
  );
  expect(ceiling).toMatchObject({ success: false });
  expect(services.http).toHaveBeenCalledTimes(count);
  session.activeSkillPolicy = null;
  const approvalsBefore = approvals().length;
  const replaced = call(
    'RequestConnectionAccess',
    { connectionId: services.connection.id },
    'replacement-during-approval',
  );
  await vi.waitFor(() => expect(approvals().length).toBeGreaterThan(approvalsBefore), {
    timeout: 10000,
  });
  setCredentialConnectionsRuntime(null);
  resolvePending(approvals().at(-1)!.permId, 'once', undefined, f.reservation.conversationId);
  expect(await replaced).toMatchObject({ success: false });
  setCredentialConnectionsRuntime(services.service);
  await approve(
    call('RequestConnectionAccess', { connectionId: services.connection.id }, 'grant-for-cancel'),
    approvals().length,
  );
  const abort = new AbortController();
  let releaseSecret!: (value: string) => void;
  const vaultReads = services.vault.read.mock.calls.length;
  services.vault.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseSecret = resolve;
      }),
  );
  const cancelled = call(
    'ConnectionRequest',
    { connectionId: services.connection.id, path: '/api/states', method: 'GET' },
    'cancelled-vault-read',
    abort.signal,
  ).then(
    (result) => result.success === false,
    () => true,
  );
  await vi.waitFor(
    () => expect(services.vault.read.mock.calls.length).toBeGreaterThan(vaultReads),
    { timeout: 10000 },
  );
  abort.abort();
  releaseSecret('SECRET_SYNTHETIC_KEYCHAIN_TOKEN');
  expect(await cancelled).toBe(true);
  expect(services.http).toHaveBeenCalledTimes(count);
  expect(JSON.stringify(transport.send.mock.calls)).not.toContain('SECRET');
}, 60000);
