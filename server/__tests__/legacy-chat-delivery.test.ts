import { expect, it, vi } from 'vitest';
import {
  SessionControlRejected,
  assertOrdinaryContributorControlAllowed,
} from '../ordinary-contributor-execution.js';

it.each(['send', 'interrupt'] as const)(
  'retains exact identity on legacy %s ownership rejection',
  (control) => {
    const error = new SessionControlRejected(
      'owned-child',
      control,
      'Use contributor directed messages',
      'CONTRIBUTOR_DIRECTED_MESSAGE_REQUIRED',
    );
    expect(error.toMessage('submitted-command')).toEqual({
      type: 'session_control_rejected',
      sessionId: 'owned-child',
      control,
      error: error.message,
      code: error.code,
      clientMsgId: 'submitted-command',
    });
  },
);

it('delivers an asynchronous legacy refusal without emitting a terminal stream error', async () => {
  const { deliverLegacyChatMessage } = await import('../legacy-chat-delivery.js');
  const rejection = new SessionControlRejected(
    'owned-child',
    'send',
    'Use contributor directed messages',
    'CONTRIBUTOR_DIRECTED_MESSAGE_REQUIRED',
  );
  const transport = { send: vi.fn(), isOpen: () => true };
  const queryDispatch = vi.fn();
  const send = vi.fn(async () => {
    assertOrdinaryContributorControlAllowed(
      {
        getSessionEvents: () => [
          {
            type: 'contributor_execution',
            payload: {
              coordinatorSessionId: 'parent',
              deliveryId: 'delivery',
              seatId: 'seat',
              claimToken: 'claim',
              idempotencyKey: 'recipient',
              childSessionId: 'owned-child',
            },
          },
        ],
        getUnsettledSymposiumSeatExecutions: () => [
          { claimToken: 'claim', idempotencyKey: 'recipient' },
        ],
      },
      'owned-child',
      'send',
    );
    queryDispatch();
    return true;
  });
  const report = vi.fn();
  await deliverLegacyChatMessage(transport, send, 'submitted-command', report);
  expect(send).toHaveBeenCalledTimes(1);
  expect(queryDispatch).not.toHaveBeenCalled();
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      ...rejection.toMessage(),
      error: expect.stringMatching(/directed messages/),
      clientMsgId: 'submitted-command',
    }),
  );
  expect(transport.send.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
});

it('does not retry dispatch or leak a rejection when its viewer transport has closed', async () => {
  const { deliverLegacyChatMessage } = await import('../legacy-chat-delivery.js');
  const closed = new Error('closed viewer');
  const transport = {
    send: vi.fn(() => {
      throw closed;
    }),
    isOpen: () => false,
  };
  const send = vi.fn(async () => {
    throw new SessionControlRejected('child', 'send', 'Use panel');
  });
  const report = vi.fn();
  const reportDelivery = vi.fn();
  await expect(
    deliverLegacyChatMessage(transport, send, 'command', report, reportDelivery),
  ).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(reportDelivery).toHaveBeenCalledExactlyOnceWith(closed);
});

it.each(['native slash command', 'observer resume'])(
  'fences legacy %s before routing an unsettled child',
  async () => {
    const { routeLegacyChatSend } = await import('../legacy-chat-delivery.js');
    const route = vi.fn();
    const store = {
      getSessionEvents: () => [
        {
          type: 'contributor_execution',
          payload: {
            coordinatorSessionId: 'parent',
            deliveryId: 'delivery',
            seatId: 'seat',
            claimToken: 'claim',
            idempotencyKey: 'recipient',
            childSessionId: 'owned-child',
          },
        },
      ],
      getUnsettledSymposiumSeatExecutions: () => [
        { claimToken: 'claim', idempotencyKey: 'recipient' },
      ],
    };
    expect(() => routeLegacyChatSend(store, 'owned-child', route)).toThrow(SessionControlRejected);
    expect(route).not.toHaveBeenCalled();
  },
);

it.each([undefined, 'ordinary'])(
  'preserves ordinary legacy routing for session %s',
  async (sessionId) => {
    const { routeLegacyChatSend } = await import('../legacy-chat-delivery.js');
    const store = {
      getSessionEvents: vi.fn(() => []),
      getUnsettledSymposiumSeatExecutions: vi.fn(() => []),
    };
    const route = vi.fn(() => 'accepted');
    expect(routeLegacyChatSend(store, sessionId, route)).toBe('accepted');
    expect(route).toHaveBeenCalledTimes(1);
    expect(store.getUnsettledSymposiumSeatExecutions).not.toHaveBeenCalled();
  },
);

it('preserves successful legacy saved-message delivery and ordinary terminal error compatibility', async () => {
  const { deliverLegacyChatMessage } = await import('../legacy-chat-delivery.js');
  const transport = { send: vi.fn(), isOpen: () => true };
  await deliverLegacyChatMessage(transport, async () => true, 'accepted', vi.fn());
  expect(transport.send).not.toHaveBeenCalled();
  await deliverLegacyChatMessage(
    transport,
    async () => {
      throw new Error('ordinary failure');
    },
    undefined,
    vi.fn(),
  );
  expect(transport.send).toHaveBeenCalledExactlyOnceWith({
    type: 'error',
    error: 'ordinary failure',
  });
  expect(
    new SessionControlRejected('child', 'stop', 'Stop from panel').toMessage(),
  ).not.toHaveProperty('clientMsgId');
});
