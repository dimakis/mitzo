import { describe, expect, it } from 'vitest';
import { credentialConnectionToolDefinitions } from '../credential-connection-tools.js';
import { connectionGuide } from '../connection-guide.js';
import { CONNECTION_TOOL_INSTRUCTIONS } from '../session-credential-tools.js';

describe('runtime-owned connection guidance', () => {
  it('keeps the initial hint small and defers workflow detail to the guide', () => {
    expect(CONNECTION_TOOL_INSTRUCTIONS.length).toBeLessThan(500);
    expect(CONNECTION_TOOL_INSTRUCTIONS).toContain('GetConnectionGuide');
    expect(CONNECTION_TOOL_INSTRUCTIONS).not.toContain('direct the user to Connections');
  });

  it('returns only the requested guidance and derives available tools from the runtime registry', () => {
    const guide = connectionGuide('connect', credentialConnectionToolDefinitions);
    expect(guide.topic).toBe('connect');
    expect(guide.instructions).toContain('PrepareConnectionSetup');
    expect(guide.instructions).toContain('official');
    expect(guide.instructions).toContain('never guess');
    expect(guide.instructions).toContain('original task');
    expect(guide.tools).toEqual(credentialConnectionToolDefinitions.map(({ name }) => name));
    expect(guide.instructions).not.toContain('expectedConfigHash');
    expect(connectionGuide('use', credentialConnectionToolDefinitions).instructions).toContain(
      'expectedConfigHash',
    );
  });
});
