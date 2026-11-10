import { expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { EventStore } from '../../event-store.js';

/** Only external native execution and its synthetic qualification are replaced. */
export async function recordApplicationMessagingRuntime(events: EventStore) {
  const { CodexAppServerClient } = await import('../../codex-app-server-client.js');
  // Runtime declaration/qualification is synthetic, just like the external
  // process below. Accept only this fixture's inert bytes, never a host artifact.
  const qualification = await import('../../codex-native-artifact-qualification.js');
  const artifact = vi
    .spyOn(qualification, 'assertQualifiedNativeMacExecutionArtifact')
    .mockImplementation((sha256) =>
      expect(sha256).toBe(
        createHash('sha256')
          .update(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]))
          .digest('hex'),
      ),
    );
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const heldTurns = new Set<number>();
  const pendingTurns = new Map<
    number,
    (status: 'completed' | 'failed', failure?: 'context') => void
  >();
  // The account catalog uses a separate read-only native discovery process.
  // Keep its real cache/qualification owner; substitute only the external RPC.
  const discoveryClient = () =>
    ({
      initialize: async () => {},
      close: () => {},
      request: async (method: string) => {
        if (method === 'account/read')
          return {
            account: { type: 'chatgpt', email: 'offline@example.invalid', planType: 'plus' },
          };
        if (method === 'model/list')
          return {
            data: [
              {
                id: 'fixture-model',
                model: 'fixture-model',
                displayName: 'Offline fixture',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
            nextCursor: null,
          };
        throw Error(`Unexpected offline discovery method: ${method}`);
      },
    }) as never;
  const discovery = vi.spyOn(CodexAppServerClient, 'launch').mockImplementation(discoveryClient);
  const preflight = vi
    .spyOn(CodexAppServerClient, 'launchPreflight')
    .mockImplementation(discoveryClient);
  let revokeSourceOnQualification = false;
  let nativeThreads = 0;
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockImplementation((_home, _env, lifecycle) => {
      const threadId = `private-native-thread-${++nativeThreads}`;
      let retainedTurn:
        | {
            id: string;
            status: 'inProgress' | 'completed' | 'failed';
            error?: { codex_error_info: string };
          }
        | undefined;
      return {
        initialize: async () => {},
        close: () => {},
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === 'account/read')
            return {
              account: { type: 'chatgpt', email: 'offline@example.invalid', planType: 'plus' },
            };
          if (method === 'config/read') return { config: {} };
          if (method === 'model/list') {
            if (revokeSourceOnQualification) events.hideSession('existing-chat');
            return {
              data: [
                {
                  model: 'fixture-model',
                  displayName: 'Offline',
                  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                },
              ],
              nextCursor: null,
            };
          }
          if (method === 'thread/start')
            return {
              thread: { id: threadId },
              model: 'fixture-model',
              modelProvider: 'openai',
            };
          if (method === 'thread/turns/list') {
            if (params.threadId !== threadId || !retainedTurn)
              throw Error('Unknown synthetic native recovery thread');
            return {
              data: [{ ...retainedTurn, error: retainedTurn.error ?? null }],
              nextCursor: null,
            };
          }
          if (method === 'turn/interrupt') {
            if (params.threadId !== threadId || params.turnId !== retainedTurn?.id)
              throw Error('Wrong synthetic native Stop target');
            // External cancellation ACK is not terminal proof; the held provider
            // turn may complete/fail concurrently and is settled separately.
            return {};
          }
          if (method === 'turn/start') {
            const turnNumber = requests.filter((r) => r.method === 'turn/start').length;
            const turnId = `private-native-turn-${turnNumber}`;
            retainedTurn = { id: turnId, status: 'inProgress' };
            setTimeout(() => {
              lifecycle!.onNotification('turn/started', {
                threadId,
                turn: { id: turnId, status: 'inProgress' },
              });
              const finish = (status: 'completed' | 'failed', failure?: 'context') => {
                const error =
                  failure === 'context'
                    ? { codex_error_info: 'context_window_exceeded' }
                    : undefined;
                retainedTurn = { id: turnId, status, error };
                if (status === 'completed')
                  lifecycle!.onNotification('item/completed', {
                    threadId,
                    turnId,
                    item: {
                      id: `native-answer-${turnNumber}`,
                      type: 'agentMessage',
                      text: 'Reviewed the selected design.',
                    },
                  });
                lifecycle!.onNotification('turn/completed', {
                  threadId,
                  turn: { id: turnId, status, ...(error ? { error } : {}) },
                });
              };
              if (heldTurns.has(turnNumber)) pendingTurns.set(turnNumber, finish);
              else finish('completed');
            }, 10);
            return { turn: { id: turnId } };
          }
          throw Error(`Unexpected offline native method: ${method}`);
        },
      } as never;
    });
  return {
    requests,
    holdTurn: (turnNumber: number) => heldTurns.add(turnNumber),
    finishTurn: (turnNumber: number, status: 'completed' | 'failed', failure?: 'context') => {
      const finish = pendingTurns.get(turnNumber);
      if (!finish) throw Error('Synthetic turn is not waiting');
      pendingTurns.delete(turnNumber);
      finish(status, failure);
    },
    revokeSource: () => {
      revokeSourceOnQualification = true;
    },
    restore: () => {
      launch.mockRestore();
      discovery.mockRestore();
      preflight.mockRestore();
      artifact.mockRestore();
    },
  };
}
