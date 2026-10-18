import { describe, expect, it } from 'vitest';
import { credentialConnectionToolDefinitions } from '../credential-connection-tools.js';
import { connectionGuide } from '../connection-guide.js';
import { CONNECTION_TOOL_INSTRUCTIONS } from '../session-credential-tools.js';

describe('runtime-owned connection guidance', () => {
  it('routes hardware identity through the spoke cache and distinguishes stale data from absence', () => {
    const guide = connectionGuide('use', credentialConnectionToolDefinitions);
    expect(guide.instructions).toContain('HomeAssistantInventory first');
    expect(guide.instructions).toContain('stale or incomplete cache');
    expect(
      connectionGuide('troubleshoot', credentialConnectionToolDefinitions).instructions,
    ).toContain('response_too_large');
  });
  it('routes API-account Jira reads through approved connections instead of a networkless CLI', () => {
    const guide = connectionGuide('use', credentialConnectionToolDefinitions);
    expect(guide.instructions).toContain('ConnectionRequest');
    expect(guide.instructions).toContain('search/jql');
    expect(connectionGuide('connect', credentialConnectionToolDefinitions).instructions).toContain(
      'profile "jira"',
    );
    expect(
      connectionGuide('troubleshoot', credentialConnectionToolDefinitions).instructions,
    ).toContain('requests');
  });
  it('keeps the initial hint small and defers workflow detail to the guide', () => {
    expect(CONNECTION_TOOL_INSTRUCTIONS.length).toBeLessThan(500);
    expect(CONNECTION_TOOL_INSTRUCTIONS).toContain('GetConnectionGuide');
    expect(CONNECTION_TOOL_INSTRUCTIONS).not.toContain('direct the user to Connections');
  });

  it('separates Google session approval, OAuth consent and enforced endpoint policy', () => {
    const guide = connectionGuide('use', credentialConnectionToolDefinitions);
    expect(guide.instructions).toContain('gws docs documents create');
    expect(guide.instructions).toContain('gws docs documents batchUpdate');
    expect(guide.instructions).toContain('does not change OAuth consent or provider policy');
    const repair = connectionGuide('troubleshoot', credentialConnectionToolDefinitions);
    expect(repair.instructions).toContain('Do not retry through Drive');
    expect(repair.instructions).toContain('no write-access toggle');
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
