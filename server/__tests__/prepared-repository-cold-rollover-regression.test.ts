import { fixture, cleanups } from './fixtures/prepared-repository-native-consumer.js';
import { expect, it, vi } from 'vitest';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';

it('keeps a cold prepared-checkout lease alive while its own provider replacement awaits acknowledgement', async () => {
  const f = await fixture(false, 300000);
  const workspace = (await f.adopt())!;
  f.setCwd(workspace.directory);
  f.runtime.close();
  const request = {
    ...structuredClone(f.request),
    clientMsgId: 'continue-after-redeploy',
    payload: { text: 'Can you try now?' },
  };
  const client = { ...f.rpc, close: vi.fn() };
  const dispatch = vi.fn(
    async (
      value: import('../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
    ) => {
      const input = {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      };
      value.admission.assertBeforeEnqueue(input);
      f.native.enqueue(value.sessionId, value.lease.binding, input);
    },
  );
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: f.native,
    commandId: request.clientMsgId,
    reservation: { ...f.reservation, id: workspace.id },
    launch: () => client,
    dispatch,
  });
  cleanups.push(() => cold.close());
  await expect(cold.admitResume(request)).resolves.toEqual({ dispatched: true });
  const packet = dispatch.mock.calls[0][0];
  const owner = {
    onNotification: vi.fn(),
    onRequest: vi.fn(async () => ({})),
    onClose: vi.fn(),
  };
  // Use the production bridge and the genuine retained bootstrap lease. RPC
  // remains synthetic; no native provider or model is launched by this test.
  const bridge = new OwnedCodexLifecycleBridge(() => packet.lease);
  bridge.attach(owner);
  const command = f.native.claimNext(packet.sessionId, packet.lease.binding)!;
  packet.admission.assertBeforeDispatch(command.id);
  expect(() => packet.lease.assertCurrentSync()).not.toThrow();
  f.native.beginThreadReplacementDispatch(
    packet.sessionId,
    packet.lease.binding,
    'thread',
    'updated-tools-thread',
    command,
  );
  expect(() =>
    bridge.lifecycle.onNotification('turn/started', {
      threadId: 'updated-tools-thread',
      turn: { id: 'new-turn' },
    }),
  ).not.toThrow();
  expect(owner.onNotification).toHaveBeenCalledOnce();
  expect(owner.onClose).not.toHaveBeenCalled();
  expect(client.close).not.toHaveBeenCalled();
});
