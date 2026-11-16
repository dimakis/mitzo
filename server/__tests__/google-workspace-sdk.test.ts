import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, setSkillPolicy } from '@mitzo/harness';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import {
  assertAgentToolRoute,
  bindAgentToolSelection,
  agentToolAllowed,
} from '../agent-tool-selection.js';
import { setConnectionsRuntime } from '../connections-runtime.js';
import { GoogleWorkspaceManagement } from '../google-workspace-management.js';
import { googleReadFixture } from './fixtures/google-workspace-read.js';
import { resolvePending } from '../../packages/harness/src/permissions.js';
import { googleReadSessionApproval } from '../google-workspace-read.js';
import { TurnCallbacks, retainCallbackOutcome } from '../turn-callbacks.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setConnectionsRuntime(null);
  vi.restoreAllMocks();
});
async function fixture(selected?: boolean, checkTool?: (wire: string) => 'allow' | 'deny') {
  const google = googleReadFixture();
  const service = new GoogleWorkspaceManagement(google.options);
  setConnectionsRuntime({
    googleWorkspace: service,
  } as never);
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('owner', {
    sessionId: 'google-chat',
    mode: 'auto',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
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
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  const server = createCredentialSdkServer(() => session.sessionId, session, registry, {
    profilesOnly: true,
    connectionBoundary: 'sdk-callback',
    assertCurrent: async () => assert(),
    assertCurrentSync: assert,
    runCallback: (work) => callbacks.track(work),
    checkTool,
  });
  const client = new Client({ name: 'offline-google', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const read = (
    args: Record<string, unknown> = {
      operation: 'drive.export',
      fileId: 'document',
      mimeType: 'text/plain',
    },
  ) => client.callTool({ name: 'GoogleWorkspaceRead', arguments: args });
  return {
    google,
    service,
    registry,
    session,
    client,
    read,
    callbacks,
    retire: () => {
      current = false;
    },
  };
}

it('advertises numeric and list fields through the actual SDK tools/list transport', async () => {
  const f = await fixture();
  const listed = (await f.client.listTools()).tools.find(
    (tool) => tool.name === 'GoogleWorkspaceRead',
  )!;
  expect(listed.inputSchema).toMatchObject({
    type: 'object',
    required: ['operation'],
    properties: {
      operation: {
        enum: [
          'drive.list',
          'drive.get',
          'drive.export',
          'docs.get',
          'sheets.get',
          'slides.get',
          'calendar.list',
        ],
      },
      pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      ranges: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
    },
  });
});

it.each([
  [{ operation: 'drive.list', pageSize: 7 }, 'pageSize=7'],
  [{ operation: 'calendar.list', maxResults: 9 }, 'maxResults=9'],
  [
    { operation: 'sheets.get', spreadsheetId: 'sheet', ranges: ['Sheet1!A1:B2', 'Sheet2!C3'] },
    'ranges=Sheet1%21A1%3AB2&ranges=Sheet2%21C3',
  ],
] as const)('dispatches typed Google arguments %j', async (input, query) => {
  const f = await fixture();
  expect((await f.read(input)).isError).not.toBe(true);
  expect(JSON.stringify(f.google.readRequest.mock.calls)).toContain(query);
});

it.each([
  { operation: 'drive.get' },
  { operation: 'drive.get', fileId: 'document', pageSize: 7 },
  { operation: 'calendar.list', ranges: ['A1'] },
])('reports canonical operation validation before any Google preparation: %j', async (input) => {
  const f = await fixture();
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__GoogleWorkspaceRead',
      input,
      'owner',
      f.registry,
      f.session,
    ),
  ).toMatchObject({ behavior: 'allow' });
  const result = await f.read(input);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('invalid_input');
  expect(f.google.exportCredentials).not.toHaveBeenCalled();
  expect(f.google.readRequest).not.toHaveBeenCalled();
  await expect(f.callbacks.settle(new AbortController().signal)).resolves.toBeUndefined();
});

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
it.each([
  { operation: 'drive.list', pageSize: '7' },
  { operation: 'calendar.list', maxResults: 101 },
  { operation: 'sheets.get', spreadsheetId: 'sheet', ranges: 'A1' },
])('rejects invalid advertised types/ranges before credential preparation: %j', async (input) => {
  const f = await fixture();
  const result = await f.read(input);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('validation');
  expect(f.google.exportCredentials).not.toHaveBeenCalled();
  expect(f.google.readRequest).not.toHaveBeenCalled();
});

it.each(['deny', 'expire', 'cancel'] as const)(
  'distinguishes Google approval %s from argument validation',
  async (decision) => {
    const f = await fixture();
    f.session.mode = 'agent';
    const cards: Record<string, unknown>[] = [];
    f.session.transport = {
      isOpen: () => true,
      send(event: Record<string, unknown>) {
        if (event.type !== 'permission_request') return;
        cards.push(event);
        queueMicrotask(() => {
          if (decision === 'cancel') {
            f.session.abortController.abort();
            return;
          }
          const clock =
            decision === 'expire'
              ? vi.spyOn(Date, 'now').mockReturnValue(Number(event.expiresAt) + 1)
              : undefined;
          try {
            resolvePending(String(event.permId), decision === 'deny' ? 'deny' : 'once');
          } finally {
            clock?.mockRestore();
          }
        });
      },
    } as never;
    const result = await f.read({ operation: 'drive.list', pageSize: 7 });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).not.toContain('invalid_input');
    expect(text).toMatch(
      decision === 'expire'
        ? /approval_expired/
        : decision === 'cancel'
          ? /cancelled|aborted/
          : /denied/,
    );
    expect(cards).toHaveLength(1);
    expect(f.google.readRequest).not.toHaveBeenCalled();
  },
);
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
it.each([false, true])(
  'checks the original Google command wire ceiling, selected=%s',
  async (allowed) => {
    const expected = 'mcp__mitzo-connections__GoogleWorkspaceRead';
    const checkTool = vi.fn((wire: string): 'allow' | 'deny' =>
      allowed && wire === expected ? 'allow' : 'deny',
    );
    const f = await fixture(true, checkTool);
    const result = await f.read();
    expect(result.isError === true).toBe(!allowed);
    expect(checkTool).toHaveBeenCalledWith(expected);
    expect(f.google.readRequest).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(f.google.exportCredentials).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);
it('rechecks the frozen Google ceiling after asynchronous credential preparation', async () => {
  let allowed = true;
  const f = await fixture(true, () => (allowed ? 'allow' : 'deny'));
  const exportCredentials = f.google.exportCredentials.getMockImplementation()!;
  f.google.exportCredentials.mockImplementationOnce(async () => {
    allowed = false;
    return exportCredentials();
  });
  expect((await f.read()).isError).toBe(true);
  expect(f.google.readRequest).not.toHaveBeenCalled();
});
it('returns a sanitized visible diagnostic for a failed Google read', async () => {
  const f = await fixture();
  f.google.readRequest.mockRejectedValueOnce(Error('SECRET_UPSTREAM'));
  const result = await f.read();
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('diagnosticId');
  expect(JSON.stringify(result)).not.toContain('SECRET');
  await expect(f.callbacks.settle(new AbortController().signal)).resolves.toBeUndefined();
});
it('settles a sanitized Google preparation failure without starting a resource read', async () => {
  const f = await fixture();
  f.google.exportCredentials.mockRejectedValueOnce(Error('SECRET_EXPORT_FAILURE'));
  const result = await f.read();
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('diagnosticId');
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(f.google.readRequest).not.toHaveBeenCalled();
  await expect(f.callbacks.settle(new AbortController().signal)).resolves.toBeUndefined();
});
it.each([false, true])(
  'retains Ask-mode Google consent, existing session grant=%s',
  async (granted) => {
    const f = await fixture(true);
    f.session.mode = 'ask';
    const send = vi.fn((event: { type: string; permId: string }) => {
      if (event.type === 'permission_request')
        queueMicrotask(() => resolvePending(event.permId, 'once'));
    });
    f.session.transport = { isOpen: () => true, send } as never;
    if (granted)
      f.session.sessionAllowList.add(
        googleReadSessionApproval(f.session, 'fixture@example.test').sessionGrantKey,
      );
    expect((await f.read()).isError).not.toBe(true);
    expect(f.google.readRequest).toHaveBeenCalledOnce();
    expect(send.mock.calls.filter(([event]) => event.type === 'permission_request')).toHaveLength(
      granted ? 0 : 1,
    );
    await expect(f.callbacks.settle(new AbortController().signal)).resolves.toBeUndefined();
  },
);
it.each(['cancelled', 'retired', 'uncertain'] as const)(
  'does not settle a Google read failure after %s',
  async (reason) => {
    const f = await fixture();
    f.google.readRequest.mockImplementationOnce(async () => {
      if (reason === 'cancelled') f.session.abortController.abort();
      if (reason === 'retired') f.retire();
      throw reason === 'uncertain'
        ? retainCallbackOutcome(Error('SECRET_UNCERTAIN'), 'unknown')
        : Error('SECRET_UPSTREAM');
    });
    expect((await f.read()).isError).toBe(true);
    await expect(f.callbacks.settle(new AbortController().signal)).rejects.toThrow();
  },
);
it.each(['cancelled', 'retired', 'uncertain'] as const)(
  'does not settle a Google preparation failure after %s',
  async (reason) => {
    const f = await fixture();
    // Only an original trusted service owner can attach an uncertainty receipt.
    // Raw credential-provider errors are sanitized inside that owner.
    if (reason === 'uncertain')
      vi.spyOn(f.service, 'prepareRead').mockRejectedValueOnce(
        retainCallbackOutcome(Error('SECRET_UNCERTAIN'), 'unknown'),
      );
    else
      f.google.exportCredentials.mockImplementationOnce(async () => {
        if (reason === 'cancelled') f.session.abortController.abort();
        if (reason === 'retired') f.retire();
        throw Error('SECRET_EXPORT_FAILURE');
      });
    expect((await f.read()).isError).toBe(true);
    expect(f.google.readRequest).not.toHaveBeenCalled();
    await expect(f.callbacks.settle(new AbortController().signal)).rejects.toThrow();
  },
);
it('uses the existing web handler for explicitly selected SDK web profiles', () => {
  const session = {};
  const profile = { tools: [{ id: 'mitzo:RequestWebAccess', version: 1 }] } as never;
  assertAgentToolRoute(profile, 'claude-sdk');
  bindAgentToolSelection(session, profile, 'claude-sdk');
  expect(agentToolAllowed(session, 'mcp__mitzo-web-access__RequestWebAccess')).toBe(true);
  expect(agentToolAllowed(session, 'mcp__other__RequestWebAccess')).toBe(false);
});
