import { expect, it } from 'vitest';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import { sessionLaunchDefinitions } from '../session-launch-tools.js';

it('publishes StartSession on the ordinary owned Local Codex route', () => {
  const tool = agentToolCatalog().find((entry) => entry.name === 'StartSession');
  expect(tool).toMatchObject({
    id: 'mitzo:StartSession',
    behavior: 'write',
    routes: ['codex-owned-local', 'claude-sdk'],
  });
  expect(sessionLaunchDefinitions[0].description).toContain('pending');
});
