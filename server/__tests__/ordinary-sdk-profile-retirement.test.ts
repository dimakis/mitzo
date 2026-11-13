import './fixtures/offline-user-home.js';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { createCredentialSdkServer } from '../credential-sdk-tools.js';
import { createSdkCallbackState } from '../ordinary-local-vertex-sdk-query.js';
// Regression supplied by the independent combined-candidate review.
const effect = vi.hoisted(() => vi.fn());
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerClient: { request: effect },
}));

it.each(
  [
    { name: 'SymposiumReadProfiles', input: { action: 'list' }, body: [] },
    {
      name: 'SymposiumProposeProfile',
      input: {
        definition: {
          name: 'Review probe',
          role: 'agent',
          instructions: 'Offline probe',
          expectedOutput: 'Evidence',
          acceptanceCriteria: ['Evidence'],
          modelPolicyRole: 'agent',
        },
      },
      body: { proposalId: 'offline-proposal' },
    },
  ].flatMap((row) => [true, false].map((retire) => ({ ...row, retire }))),
)(
  'retains the original SDK owner for $name (retire: $retire)',
  async ({ name, input, body, retire }) => {
    effect.mockClear();
    const registry = new SessionRegistry();
    const controller = new AbortController();
    registry.register('owner', {
      sessionId: 'original-session',
      mode: 'agent',
      cwd: '/task',
      sessionAllowList: new Set(),
      abortController: controller,
      transport: { send() {}, isOpen: () => true },
      ownedLocalAuthSessionId: 'operator',
    });
    const unbind = bindAgentLibraryTransport('owner', {
      id: 'operator',
      expiresAt: Date.now() + 600000,
    });
    const session = registry.get('owner')!;
    bindAgentToolSelection(session, undefined, 'claude-sdk');
    const state = createSdkCallbackState();
    state.bindCommandToolAuthority({ commandId: 'original-command', checkTool: () => 'allow' });
    let awaits = 0;
    let scheduled = false;
    effect.mockImplementation(async () => {
      expect(state.retired).toBe(false);
      return { status: 200, body };
    });
    const server = createCredentialSdkServer(() => 'original-session', session, registry, {
      profilesOnly: true,
      runCallback: state.runCallback,
      checkTool(name) {
        const decision = state.checkTool(name);
        // The fourth runtime await is the profile consumer's final pre-dispatch check.
        // Retire after its wrapper checks, before that consumer resumes.
        if (retire && awaits === 4 && !scheduled) {
          scheduled = true;
          queueMicrotask(() => {
            state.retired = true;
          });
        }
        return decision;
      },
      async assertCurrent() {
        awaits++;
      },
      assertCurrentSync() {},
    });
    const client = new Client({ name: 'review-probe', version: '1' });
    const [st, ct] = InMemoryTransport.createLinkedPair();
    try {
      await server.instance.connect(st);
      await client.connect(ct);
      const result = await client.callTool({ name, arguments: input });
      expect(scheduled).toBe(retire);
      expect(result.isError).toBe(retire);
      expect(effect).toHaveBeenCalledTimes(retire ? 0 : 1);
    } finally {
      await client.close();
      await server.instance.close();
      unbind();
      controller.abort();
      registry.dispose();
    }
  },
);
