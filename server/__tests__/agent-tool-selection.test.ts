import { afterEach, expect, it, vi } from 'vitest';
import { AgentLibraryStore } from '../agent-library-store.js';
import { resolveChatAgentProfile } from '../agent-library-binding.js';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { SessionRegistry } from '@mitzo/harness';
import { bindAgentToolSelection, agentToolAllowed } from '../agent-tool-selection.js';

const library = new AgentLibraryStore(':memory:');
it('admits the selected Telos creation tool through its Claude MCP name only', () => {
  const session = {};
  bindAgentToolSelection(session, {
    tools: [{ id: 'mitzo:TelosCreateSession', version: 1 }],
  } as never);
  expect(agentToolAllowed(session, 'mcp__telos__TelosCreateSession')).toBe(true);
  expect(agentToolAllowed(session, 'mcp__untrusted__TelosCreateSession')).toBe(false);
  const unselected = {};
  bindAgentToolSelection(unselected, { tools: [] } as never);
  expect(agentToolAllowed(unselected, 'mcp__telos__TelosCreateSession')).toBe(false);
});
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
    toolRoute: 'local-api',
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
  const guide = await tools.execute('GetConnectionGuide', {}, new AbortController().signal);
  expect(JSON.parse(guide!.content).tools.sort()).toEqual([
    'GetConnectionGuide',
    'ListConnections',
  ]);
  expect(request).not.toHaveBeenCalled();
  library.close();
});
