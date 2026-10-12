import { expect, it, vi } from 'vitest';
import type { WebSocketRoute } from '@playwright/test';
import { keepIdleOfflineWebSocket } from '../idle-offline-websocket.js';

function socket() {
  let receive: (message: string | Buffer) => void;
  const route = {
    onMessage: vi.fn((callback: typeof receive) => {
      receive = callback;
    }),
    send: vi.fn(),
    close: vi.fn(),
  };
  return {
    route,
    receive: (message: string | Buffer) => receive(message),
  };
}
it('keeps the offline peer open instead of provoking reconnect auth checks', () => {
  const peer = socket();
  keepIdleOfflineWebSocket(peer.route as unknown as WebSocketRoute);
  expect(peer.route.onMessage).toHaveBeenCalledOnce();
  expect(peer.route.send).not.toHaveBeenCalled();
  expect(peer.route.close).not.toHaveBeenCalled();
});
it('acknowledges the real v2 hello and exposes completion for navigation checks', () => {
  const peer = socket();
  const welcomed = vi.fn();
  keepIdleOfflineWebSocket(peer.route as unknown as WebSocketRoute, welcomed);
  peer.receive(JSON.stringify({ type: 'hello', protocolVersion: 2 }));
  expect(peer.route.send).toHaveBeenCalledWith(
    JSON.stringify({
      type: 'welcome',
      protocolVersion: 2,
      connectionId: 'offline-drafts',
    }),
  );
  expect(welcomed).toHaveBeenCalledOnce();
  expect(peer.route.close).not.toHaveBeenCalled();
});
it('never fabricates execution replies or acknowledges an unsupported protocol', () => {
  const peer = socket();
  keepIdleOfflineWebSocket(peer.route as unknown as WebSocketRoute);
  for (const message of [
    'invalid JSON',
    'null',
    JSON.stringify({ type: 'hello', protocolVersion: 99 }),
    JSON.stringify({ type: 'send_message', text: 'fixture must not execute' }),
  ])
    peer.receive(message);
  expect(peer.route.send).not.toHaveBeenCalled();
  expect(peer.route.close).not.toHaveBeenCalled();
});
