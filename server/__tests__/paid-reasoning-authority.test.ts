import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelSession, ModelSessionConfig } from '@mitzo/harness';
import type { PaidReasoningPhaseSelection } from '@mitzo/protocol';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { NativeCommandRegistry } from '../native-commands.js';
import { SkillRegistry } from '../skills.js';
import {
  bindAgentLibraryTransport,
  captureAgentLibraryAuthorization,
} from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
const f = vi.hoisted(() => ({ sessions: vi.fn() }));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: (accountId: string, model: string) => ({
      accountId,
      model,
      provider: 'google-vertex',
      profileRevision: 'pinned',
    }),
    validateModelSelection() {},
    paidReasoningRate() {
      return undefined;
    },
  }),
}));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: () => ({
    catalog: {
      resolve: (runtime: {
        account: PaidReasoningPhaseSelection['binding']['account'];
        targetId: string;
      }) => ({
        status: 'compatible',
        binding: {
          version: 2,
          account: runtime.account,
          harness: { implementation: 'gemini' },
          execution: { location: 'local', targetId: runtime.targetId, targetRevision: 'target' },
        },
      }),
    },
  }),
}));
vi.mock('../terminal-adviser-model.js', () => ({ createTerminalAdviserSession: f.sessions }));
const phases = ['proposer', 'challenger'].map((role): PaidReasoningPhaseSelection => ({
  role: role === 'proposer' ? 'proposer' : 'challenger',
  binding: {
    version: 2,
    account: { accountId: `${role}-account`, provider: 'google-vertex', profileRevision: 'pinned' },
    harness: { implementation: 'gemini' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'target' },
  },
  model: 'gemini-2.5-pro',
  thinking: null,
  outputPolicy: { kind: 'native-default', acknowledgeProviderDefaults: true },
}));
let store: EventStore;
const releases: Array<() => void> = [];
beforeEach(() => {
  store = new EventStore(':memory:');
  f.sessions.mockReset();
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  store.close();
});
it.each([false, true])(
  'retains admitted login after transport binding release, with actual logout still enforced (revoke=%s)',
  async (revoke) => {
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const originalConnection = `headerless-${randomUUID()}`;
    const releaseOriginal = bindAgentLibraryTransport(originalConnection, auth);
    releases.push(releaseOriginal);
    let entered!: () => void, releaseTurn!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let first = true;
    let capturedRunConnection: string | undefined;
    f.sessions.mockImplementation(
      async (config: ModelSessionConfig, _request, owner): Promise<ModelSession> => {
        capturedRunConnection = owner.operatorConnectionId;
        expect(captureAgentLibraryAuthorization(owner.operatorConnectionId).auth.id).toBe(auth.id);
        return {
          provider: 'google-vertex',
          async *turn() {
            if (first) {
              first = false;
              entered();
              await gate;
            }
            config.signal?.throwIfAborted();
            await config.beforeDispatch?.();
            yield {
              type: 'message_start',
              message: {
                id: 'actual',
                model: config.model,
                role: 'assistant',
                usage: { input_tokens: 100, output_tokens: 50 },
              },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: '{"response":"Actual phase","position_changed":false}',
              },
            };
          },
        };
      },
    );
    const pending = new NativeCommandRegistry().execute(
      'deliberate',
      'Explain selected tradeoffs',
      new SkillRegistry({}),
      {
        paidReasoning: { operatorConnectionId: originalConnection, phaseSelections: phases },
        deliberation: {
          store,
          request: {
            sessionId: 'paid-run',
            clientMsgId: 'paid-intent',
            task: 'Explain selected tradeoffs',
          },
          onAdmitted: releaseOriginal,
        },
      },
    );
    expect(await Promise.race([firstEntered.then(() => true), pending.then(() => false)])).toBe(
      true,
    );
    expect(() => captureAgentLibraryAuthorization(originalConnection)).toThrow();
    expect(capturedRunConnection).not.toBe(originalConnection);
    if (revoke) revokeAuthSession(auth);
    releaseTurn();
    const result = await pending;
    expect(result?.content).toContain(revoke ? 'uncertain' : 'Deliberation Result');
    expect(f.sessions).toHaveBeenCalledTimes(revoke ? 1 : 6);
    expect(() => captureAgentLibraryAuthorization(capturedRunConnection)).toThrow();
  },
);
