import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_STREAM_RETRY_MS } from '../constants.js';

describe('broadcast event stream reconnect hint', () => {
  it('sends a short SSE retry before any event so browsers reconnect quickly', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'app.ts'), 'utf8');
    const start = source.indexOf(".get('/api/events'");
    const end = source.indexOf('\n});', start);
    const route = source.slice(start, end);

    expect(EVENT_STREAM_RETRY_MS).toBeLessThan(3_000); // WebKit's default
    const retryWrite = route.indexOf('res.write(`retry: ${EVENT_STREAM_RETRY_MS}\\n\\n`)');
    expect(retryWrite).toBeGreaterThan(-1);
    expect(retryWrite).toBeLessThan(route.indexOf('sseRegistry.add'));
  });
});
