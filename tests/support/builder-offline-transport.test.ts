import { expect, it, vi } from 'vitest';
import { builderOfflineTransport } from './builder-offline-transport';

it('pairs fake SSE controls and nonce acknowledgements without document network requests', async () => {
  const network = vi.fn();
  const emit = vi.fn();
  const fetch = builderOfflineTransport('https://mitzo-ui.test', network, emit);
  for (const path of [
    'switch',
    'unwatch',
    'reconnect',
    'session-event-applied',
    'reconnect-snapshot-applied',
    'suspend',
  ]) {
    const response = await fetch('/api/chat/' + path, { method: 'POST', body: '{}' });
    expect(await response.json()).toEqual({ ok: true, applied: true });
  }
  const response = await fetch('/api/chat/probe', {
    method: 'POST',
    body: JSON.stringify({ nonce: 'probe-7' }),
  });
  expect(await response.json()).toEqual({ ok: true, applied: true });
  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: '_probe', nonce: 'probe-7' });
  expect(network).not.toHaveBeenCalled();
});

it('retains interception of commands, reads, unexpected methods and foreign origins', async () => {
  const response = new Response('network fixture');
  const network = vi.fn().mockResolvedValue(response);
  const fetch = builderOfflineTransport('https://mitzo-ui.test', network, vi.fn());
  for (const [url, method] of [
    ['/api/chat/local-codex/send', 'POST'],
    ['/api/chat/send', 'POST'],
    ['/api/sessions/builder-session/meta', 'GET'],
    ['/api/chat/probe', 'GET'],
    ['https://unexpected.invalid/api/chat/probe', 'POST'],
  ]) {
    const init = { method, headers: { 'X-Connection-ID': 'offline-builder' } };
    expect(await fetch(url, init)).toBe(response);
    expect(network).toHaveBeenLastCalledWith(url, init);
  }
  expect(network).toHaveBeenCalledTimes(5);
});

it('honors cancellation and rejects invalid probes without acknowledging or dispatching them', async () => {
  const network = vi.fn();
  const emit = vi.fn();
  const fetch = builderOfflineTransport('https://mitzo-ui.test', network, emit);
  const signal = AbortSignal.abort();
  await expect(
    fetch('/api/chat/probe', { method: 'POST', body: '{"nonce":"cancelled"}', signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await expect(fetch('/api/chat/probe', { method: 'POST', body: '{}' })).rejects.toThrow(
    'Invalid offline probe',
  );
  expect(emit).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
