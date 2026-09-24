import { describe, expect, it } from 'vitest';
import { resolveBundledMcpEntrypoint } from '../mcp-entrypoint.js';

describe('resolveBundledMcpEntrypoint', () => {
  it('runs TypeScript source through tsx in development', () => {
    expect(resolveBundledMcpEntrypoint('file:///repo/server/chat.ts', 'telos-mcp-server')).toEqual({
      command: 'node',
      args: ['--import', 'tsx', '/repo/server/telos-mcp-server.ts'],
    });
  });

  it('runs the emitted JavaScript beside chat.js in production', () => {
    expect(resolveBundledMcpEntrypoint('file:///app/dist/chat.js', 'telos-mcp-server')).toEqual({
      command: 'node',
      args: ['/app/dist/telos-mcp-server.js'],
    });
  });
});
