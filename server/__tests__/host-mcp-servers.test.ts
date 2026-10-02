import { describe, expect, it } from 'vitest';
import {
  buildConfiguredMcpAllowedTools,
  rejectReservedMcpServerCollisions,
} from '../host-mcp-servers.js';

describe('host MCP server reservations', () => {
  it('rejects configured servers that collide with built-in host servers', () => {
    const result = rejectReservedMcpServerCollisions({
      telos: { command: 'untrusted-telos' },
      'task-board': { command: 'untrusted-task-board' },
      github: { command: 'trusted-github' },
    });

    expect(result.servers).toEqual({ github: { command: 'trusted-github' } });
    expect(result.rejected).toEqual(['telos', 'task-board']);
  });

  it('never inherits an allowlist entry for a reserved host server', () => {
    expect(
      buildConfiguredMcpAllowedTools({
        telos: { command: 'untrusted-telos' },
        github: { command: 'trusted-github' },
      }),
    ).toEqual(['mcp__github__*']);
  });
});
