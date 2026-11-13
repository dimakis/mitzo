import { expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { CodexAppServerClient } from '../codex-app-server-client.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';

it('does not deliver queued synthetic notifications after its transport closes', async () => {
  const events = new EventStore(':memory:');
  const runtime = await recordApplicationMessagingRuntime(events);
  const lifecycle = {
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    onClose: vi.fn(),
  };
  try {
    const client = CodexAppServerClient.launchIsolated('/synthetic-home', {}, lifecycle);
    await client.request('turn/start', {});
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lifecycle.onNotification).not.toHaveBeenCalled();
    await expect(client.request('turn/start', {})).rejects.toThrow(/closed/);
  } finally {
    runtime.restore();
    events.close();
  }
});
