// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { usePendingLaunch } from '../usePendingLaunch';
import type { SendMessageOptions } from '@mitzo/client';
afterEach(cleanup);

it('retains a failed launch, retries its identity, and dismisses only after acceptance', () => {
  const store = createTestStore();
  const launch = {
    prompt: 'Handle task',
    context: 'Task context',
    telosTaskId: 'task',
    agentName: 'mitzo-telos',
  };
  const callbacks: ((status: 'accepted' | 'failed' | 'uncertain') => void)[] = [];
  const send = vi.fn((_text: string, opts?: SendMessageOptions) =>
    callbacks.push(opts!.onDelivery!),
  );
  store.setState({ pendingSession: launch, sendMessage: send });
  const { result } = renderHook(usePendingLaunch, {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  act(() => result.current.sendMessage('Handle task', { accountId: 'personal', model: 'luna' }));
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(true);
  act(() => callbacks[0]('failed'));
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(false);
  act(() => result.current.sendMessage('Handle task', { accountId: 'personal', model: 'luna' }));
  expect(send).toHaveBeenLastCalledWith(
    'Handle task',
    expect.objectContaining({
      accountId: 'personal',
      telosTaskId: 'task',
      agentName: 'mitzo-telos',
    }),
  );
  act(() => callbacks[1]('uncertain'));
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(true);
  act(() => callbacks[1]('accepted'));
  expect(result.current.launch).toBeNull();
});

it('returns false and preserves the prompt when sending cannot queue', () => {
  const store = createTestStore();
  const launch = { prompt: 'Handle task', context: 'Task context', telosTaskId: 'task' };
  store.setState({
    pendingSession: launch,
    sendMessage: (_text, opts) => opts!.onDelivery!('failed'),
  });
  const { result } = renderHook(usePendingLaunch, {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  let sent: boolean | undefined;
  act(() => {
    sent = result.current.sendMessage(launch.prompt);
  });
  expect(sent).toBe(false);
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(false);
});
