import { afterEach, expect, it, vi } from 'vitest';
import { AgentLibraryStore } from '../agent-library-store.js';
import { resolveChatAgentProfile } from '../agent-library-binding.js';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { SessionRegistry } from '@mitzo/harness';
import { bindAgentToolSelection } from '../agent-tool-selection.js';

const library = new AgentLibraryStore(':memory:');
afterEach(() => vi.restoreAllMocks());
it('publishes a subset, exposes it, and rejects an unselected optional invocation', async () => {
  const draft = library.saveDraft('user', {
    profileId: 'limited',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Limited agent',
      role: 'agent',
      instructions: 'Inspect only.',
      expectedOutput: 'Facts',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent',
      tools: [
        { id: 'mitzo:GetConnectionGuide', version: 1 },
        { id: 'mitzo:ListConnections', version: 1 },
      ],
    },
  });
  const published = library.publish('user', {
    profileId: 'limited',
    expectedVersion: draft.version,
    idempotencyKey: 'publish',
  });
  const profile = await resolveChatAgentProfile({
    requested: { profileId: 'limited', revision: 1 },
    provider: 'openai',
    lookup: async () => published,
  });
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'chat',
    abortController: new AbortController(),
    mode: 'agent',
  } as never);
  const session = registry.get('client')!;
  bindAgentToolSelection(session, profile?.definition);
  const providers = vi.fn(() => []);
  const request = vi.fn(async () => ({ content: 'allowed', isError: false }));
  const tools = sessionCredentialTools('chat', session, registry, '', { providers, request });
  expect(tools.definitions.map((tool) => tool.name).sort()).toEqual([
    'GetConnectionGuide',
    'ListConnections',
  ]);
  expect(
    (await tools.execute('GetConnectionGuide', {}, new AbortController().signal))?.isError,
  ).toBe(false);
  expect(
    await tools.execute(
      'RequestConnectionAccess',
      { connectionId: 'openshell:github' },
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: true, content: expect.stringMatching(/not selected/i) });
  expect(request).not.toHaveBeenCalled();
  library.close();
});
