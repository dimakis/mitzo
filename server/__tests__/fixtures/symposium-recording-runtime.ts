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
  let revokeSourceOnQualification = false;
  const launch = vi.spyOn(CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, lifecycle) =>
      ({
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
              thread: { id: 'private-native-thread' },
              model: 'fixture-model',
              modelProvider: 'openai',
            };
          if (method === 'turn/start') {
            setTimeout(() => {
              lifecycle!.onNotification('item/completed', {
                threadId: 'private-native-thread',
                turnId: 'private-native-turn',
                item: {
                  id: 'native-answer',
                  type: 'agentMessage',
                  text: 'Reviewed the selected design.',
                },
              });
              lifecycle!.onNotification('turn/completed', {
                threadId: 'private-native-thread',
                turn: { id: 'private-native-turn', status: 'completed' },
              });
            }, 10);
            return { turn: { id: 'private-native-turn' } };
          }
          throw Error(`Unexpected offline native method: ${method}`);
        },
      }) as never,
  );
  return {
    requests,
    revokeSource: () => {
      revokeSourceOnQualification = true;
    },
    restore: () => {
      launch.mockRestore();
      artifact.mockRestore();
    },
  };
}
