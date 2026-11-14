import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, setSkillPolicy } from '@mitzo/harness';
import { createCredentialSdkServer } from '../credential-sdk-tools.js';
import {
  assertAgentToolRoute,
  bindAgentToolSelection,
  agentToolAllowed,
} from '../agent-tool-selection.js';
import { setConnectionsRuntime } from '../connections-runtime.js';
import { GoogleWorkspaceManagement } from '../google-workspace-management.js';
import { googleReadFixture } from './fixtures/google-workspace-read.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setConnectionsRuntime(null);
  vi.restoreAllMocks();
});
async function fixture(selected?: boolean) {
  const google = googleReadFixture();
  setConnectionsRuntime({
    googleWorkspace: new GoogleWorkspaceManagement(google.options),
  } as never);
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('owner', {
    sessionId: 'google-chat',
    mode: 'auto',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('owner')!;
  if (selected !== undefined) {
    const profile = {
      tools: selected ? [{ id: 'mitzo:GoogleWorkspaceRead', version: 1 }] : [],
    } as never;
    assertAgentToolRoute(profile, 'claude-sdk');
    bindAgentToolSelection(session, profile, 'claude-sdk');
  }
  let current = true;
  const assert = () => {
    if (!current) throw Error('original query retired');
  };
  const server = createCredentialSdkServer(() => session.sessionId, session, registry, {
    profilesOnly: true,
    connectionBoundary: 'sdk-callback',
    assertCurrent: async () => assert(),
    assertCurrentSync: assert,
  });
  const client = new Client({ name: 'offline-google', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const read = (args = { operation: 'drive.export', fileId: 'document', mimeType: 'text/plain' }) =>
    client.callTool({ name: 'GoogleWorkspaceRead', arguments: args });
  return {
    google,
    registry,
    session,
    client,
    read,
    retire: () => {
      current = false;
    },
  };
}

it.each([undefined, true])(
  'invokes the canonical Google reader via SDK MCP, selected=%s',
  async (selected) => {
    const f = await fixture(selected);
    const result = await f.read();
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Google document content from the approved read',
    );
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(f.google.readRequest).toHaveBeenCalledOnce();
  },
);
it('keeps an excluded Google tool unavailable', async () => {
  const f = await fixture(false);
  await expect(f.read()).rejects.toThrow(/Method not found/);
  expect(f.google.exportCredentials).not.toHaveBeenCalled();
});
it.each(['retired', 'cancelled', 'skill', 'invalid'] as const)(
  'prevents Google effects after %s',
  async (reason) => {
    const f = await fixture();
    if (reason === 'retired') f.retire();
    if (reason === 'cancelled') f.session.abortController.abort();
    if (reason === 'skill') setSkillPolicy(f.registry, 'owner', []);
    const result = await f.read(
      reason === 'invalid'
        ? { operation: 'drive.delete', fileId: 'document', mimeType: 'text/plain' }
        : undefined,
    );
    expect(result.isError).toBe(true);
    expect(f.google.readRequest).not.toHaveBeenCalled();
  },
);
it('honors the exact SDK wire identity in a restricted skill', async () => {
  const f = await fixture(true);
  setSkillPolicy(f.registry, 'owner', ['mcp__mitzo-connections__GoogleWorkspaceRead']);
  expect((await f.read()).isError).not.toBe(true);
});
it('returns a sanitized visible diagnostic for a failed Google read', async () => {
  const f = await fixture();
  f.google.readRequest.mockRejectedValueOnce(Error('SECRET_UPSTREAM'));
  const result = await f.read();
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('diagnosticId');
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
it('uses the existing web handler for explicitly selected SDK web profiles', () => {
  const session = {};
  const profile = { tools: [{ id: 'mitzo:RequestWebAccess', version: 1 }] } as never;
  assertAgentToolRoute(profile, 'claude-sdk');
  bindAgentToolSelection(session, profile, 'claude-sdk');
  expect(agentToolAllowed(session, 'mcp__mitzo-web-access__RequestWebAccess')).toBe(true);
  expect(agentToolAllowed(session, 'mcp__other__RequestWebAccess')).toBe(false);
});
