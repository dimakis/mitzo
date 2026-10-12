import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { AccountBinding } from '@mitzo/protocol';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
const binding: AccountBinding = {
  accountId: 'fixture',
  accountLabel: 'Fixture account',
  provider: 'openai-codex',
  profileRevision: 'revision-one',
  model: 'fixture-luna',
};
function fixture(
  location: 'local' | 'openshell' = 'local',
  ownerKind: 'ordinary' | 'symposium' = 'ordinary',
  searchBackend?: 'host' | 'openshell',
  declareLocation = true,
  deferOwnership = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'codex-access-'));
  const store = new CodexConversationStore(join(root, 'private.db'));
  let callbacks!: CodexLifecycleTransport;
  let acknowledge: (() => void) | undefined;
  let finishOwnership: (() => void) | undefined;
  const observeOwnership = vi.fn(async () => {
    if (deferOwnership)
      await new Promise<void>((resolve) => {
        finishOwnership = resolve;
      });
  });
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start' || method === 'thread/resume')
      return {
        thread: { id: 'thread' },
        model: binding.model,
        modelProvider: params.modelProvider,
      };
    if (method === 'turn/start') {
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      return { turn: { id: 'turn' } };
    }
    throw new Error(`Unexpected fixture RPC ${method}`);
  });
  const conversation = new CodexConversation({
    conversationId: 'one',
    cwd: root,
    ownerKind,
    store,
    storedBinding: binding,
    profile: {
      ...binding,
      email: 'PRIVATE_EMAIL',
      planType: 'plus',
      credentialRef: '/PRIVATE_CREDENTIAL',
    },
    systemPrompt: 'PRIVATE_PROMPT',
    ...(declareLocation ? { accessLocation: location } : {}),
    tools: [],
    deferToolSurfaceReplacement: deferOwnership,
    onThreadChanged: observeOwnership,
    emit: vi.fn(),
    executeTool: vi.fn(),
    verifyBinding: async () => ({ ...binding }),
    validateModel: (model) => {
      if (!['fixture-luna', 'fixture-luna-two', 'future-selection'].includes(model))
        throw new Error('Unsupported fixture model');
    },
    webSearchBackend: searchBackend ?? (location === 'local' ? 'host' : 'openshell'),
    modelProvider: location === 'local' ? 'openai' : 'openshell',
    ...(location === 'openshell' ? { runtimeConfig: { web_search: 'disabled' } } : {}),
    createClient: (value) => {
      callbacks = value;
      return { initialize: async () => {}, request: rpc, close: vi.fn() };
    },
  });
  cleanup.push(() => {
    conversation.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    conversation,
    rpc,
    closeTransport: () => callbacks.onClose(new Error('fixture disconnect')),
    acknowledge: () => acknowledge!(),
    observeOwnership,
    finishOwnership: () => finishOwnership!(),
  };
}
it.each(['local', 'openshell'] as const)(
  'reads initialized %s Codex ownership without provider probing or private data',
  async (location) => {
    const { conversation, rpc } = fixture(location);
    expect(conversation.readAccessObservation()).toBeUndefined();
    await conversation.initialize();
    rpc.mockClear();
    const observation = conversation.readAccessObservation()!;
    expect(observation).toEqual({
      sessionId: 'one',
      account: {
        accountId: binding.accountId,
        accountLabel: binding.accountLabel,
        provider: binding.provider,
        profileRevision: binding.profileRevision,
      },
      model: 'fixture-luna',
      modelSource: 'provider-thread',
      location,
    });
    observation.account.accountId = 'changed';
    expect(conversation.readAccessObservation()!.account.accountId).toBe('fixture');
    expect(JSON.stringify(observation)).not.toContain('PRIVATE');
    expect(rpc).not.toHaveBeenCalled();
  },
);
it('withholds live evidence until acknowledged provider thread ownership is settled', async () => {
  const held = fixture('local', 'ordinary', undefined, true, true);
  await held.conversation.initialize();
  expect(held.conversation.readAccessObservation()).toBeUndefined();
  const sending = held.conversation.send({ id: 'first', prompt: 'fixture' });
  await vi.waitFor(() => expect(held.rpc).toHaveBeenCalledWith('turn/start', expect.anything()));
  held.acknowledge();
  await vi.waitFor(() => expect(held.observeOwnership).toHaveBeenCalled());
  try {
    expect(held.conversation.readAccessObservation()).toBeUndefined();
  } finally {
    held.finishOwnership();
    await sending;
  }
  expect(held.conversation.readAccessObservation()).toBeDefined();
});
it('reports acknowledged model selection, never a preparing or queued future model', async () => {
  const { conversation, rpc, acknowledge } = fixture();
  await conversation.initialize();
  const sending = conversation.send({ id: 'first', prompt: 'fixture', model: 'fixture-luna-two' });
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('turn/start', expect.anything()));
  expect(conversation.readAccessObservation()!.model).toBe('fixture-luna');
  acknowledge();
  await sending;
  expect(conversation.readAccessObservation()).toMatchObject({
    model: 'fixture-luna-two',
    modelSource: 'accepted-turn',
  });
  await conversation.send({ id: 'next', prompt: 'queued', model: 'future-selection' });
  expect(conversation.readAccessObservation()!.model).toBe('fixture-luna-two');
});
it('uses the launcher-owned execution location, never search policy or a missing declaration', async () => {
  const configured = fixture('openshell', 'ordinary', 'openshell', false);
  await configured.conversation.initialize();
  expect(configured.conversation.readAccessObservation()).toBeUndefined();
  const launched = fixture('openshell', 'ordinary', 'host');
  await launched.conversation.initialize();
  expect(launched.conversation.readAccessObservation()!.location).toBe('openshell');
});
it('invalidates the observation on lost transport or close and excludes Symposium ownership', async () => {
  const { conversation, closeTransport } = fixture();
  await conversation.initialize();
  closeTransport();
  expect(conversation.readAccessObservation()).toBeUndefined();
  const next = fixture();
  await next.conversation.initialize();
  next.conversation.close();
  expect(next.conversation.readAccessObservation()).toBeUndefined();
  const symposium = fixture('local', 'symposium');
  await symposium.conversation.initialize();
  expect(symposium.conversation.readAccessObservation()).toBeUndefined();
});
