import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function routeSource(file: string, route: string): string {
  const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
  const start = source.indexOf(`.get('${route}'`);
  const end = source.indexOf(file === 'chat-event-stream.ts' ? '\n  });' : '\n});', start);
  return source.slice(start, end);
}

describe('SSE authentication cleanup ordering', () => {
  it.each([
    ['app.ts', '/api/events'],
    ['chat-event-stream.ts', '/api/chat/events'],
  ])('installs close cleanup before auth registration in %s', (file, route) => {
    const source = routeSource(file, route);

    expect(source.indexOf("req.on('close', cleanup)")).toBeGreaterThan(-1);
    expect(source.indexOf("req.on('close', cleanup)")).toBeLessThan(
      source.indexOf('registerAuthSession'),
    );
    expect(source).toContain('if (cleaned) return;');
  });
});
