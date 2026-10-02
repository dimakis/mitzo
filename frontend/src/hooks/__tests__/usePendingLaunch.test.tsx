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
  act(() => result.current.sendLaunch({ accountId: 'personal', model: 'luna' }));
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(true);
  act(() => callbacks[0]('failed'));
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(false);
  act(() => result.current.sendLaunch({ accountId: 'personal', model: 'luna' }));
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
    sent = result.current.sendLaunch();
  });
  expect(sent).toBe(false);
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(false);
});

it('sends ordinary text without consuming or attaching a pending launch', () => {
  const store = createTestStore();
  const launch = { prompt: 'Handle task', context: 'Task context', telosTaskId: 'task' };
  const send = vi.fn();
  store.setState({ pendingSession: launch, sendMessage: send });
  const { result } = renderHook(usePendingLaunch, {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  act(() => result.current.sendMessage('Unrelated question', { accountId: 'personal' }));
  expect(send).toHaveBeenCalledWith('Unrelated question', { accountId: 'personal' });
  expect(result.current.launch).toEqual(launch);
  expect(result.current.launchSending).toBe(false);
});

it.each(['sending', 'uncertain'] as const)(
  'keeps a %s launch across chat unmounts until its receipt arrives',
  (status) => {
    const store = createTestStore();
    const launch = { prompt: 'Handle task', context: 'Task context', telosTaskId: 'task' };
    let receipt: SendMessageOptions['onDelivery'];
    const send = vi.fn((_text: string, opts?: SendMessageOptions) => {
      receipt = opts?.onDelivery;
    });
    store.setState({ pendingSession: launch, sendMessage: send });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>
    );
    const first = renderHook(usePendingLaunch, { wrapper });
    act(() => first.result.current.sendLaunch());
    if (status === 'uncertain') act(() => receipt!('uncertain'));
    first.unmount();
    const second = renderHook(usePendingLaunch, { wrapper });
    expect(second.result.current.launch).toEqual(launch);
    expect(second.result.current.launchSending).toBe(true);
    act(() => second.result.current.sendLaunch());
    expect(send).toHaveBeenCalledTimes(1);
    act(() => receipt!('accepted'));
    expect(second.result.current.launch).toBeNull();
    expect(store.getState().pendingSession).toBeNull();
  },
);

it('ignores a dismissed launch receipt after another launch replaces it', () => {
  const store = createTestStore();
  const launch = { prompt: 'First', context: 'First context' };
  let receipt: SendMessageOptions['onDelivery'];
  store.setState({
    pendingSession: launch,
    sendMessage: (_text, opts) => {
      receipt = opts?.onDelivery;
    },
  });
  const { result } = renderHook(usePendingLaunch, {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  act(() => result.current.sendLaunch());
  act(() => result.current.dismissLaunch());
  const replacement = { prompt: 'Second', context: 'Second context' };
  act(() => store.getState().setPendingSession(replacement));
  act(() => receipt!('accepted'));
  expect(store.getState().pendingSession).toEqual(replacement);
  expect(result.current.launch).toEqual(replacement);
});
