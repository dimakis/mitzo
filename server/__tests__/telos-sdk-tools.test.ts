import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';
import { TelosItemStore } from '../telos-item-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { createTelosSdkServer, telosSdkPermission } from '../telos-sdk-tools.js';
import { telosSdkDefinitions } from '../telos-sdk-definitions.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { installTelosMainPublicationRuntime } from '../telos-main-publication-runtime.js';
import { PublicationCredentialCustodian } from '../symposium-publication-credentials.js';
import { CredentialResolver } from '../credentials.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { bindAgentToolSelection, assertAgentToolRoute } from '../agent-tool-selection.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'planning', cwd: '/fixture' })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'original-input' }]),
}));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(explicit: boolean | 'excluded' = false) {
  const data = createTelosCanonicalData();
  cleanup.push(() => data.close());
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  let approved = true;
  let beforeApproval = () => {};
  registry.register('client', {
    sessionId: 'planning',
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport: {
      isOpen: () => true,
      send(event) {
        if (event.type === 'permission_request' && typeof event.permId === 'string') {
          const permId = event.permId;
          queueMicrotask(() => {
            beforeApproval();
            resolvePending(permId, approved ? 'once' : 'deny');
          });
        }
      },
    },
  });
  const session = registry.get('client')!;
  const revoke = bindAgentLibraryTransport('client', {
    id: data.actor.id,
    expiresAt: Date.now() + 600_000,
  });
  cleanup.push(revoke);
  const runtime = installTelosMainPublicationRuntime({
    registry,
    events: data.events,
    databasePath: () => data.dbPath,
    registrations: [],
    custodian: new PublicationCredentialCustodian(new CredentialResolver({})),
  });
  cleanup.push(() => runtime.close());
  const definition = explicit
    ? {
        tools:
          explicit === 'excluded'
            ? []
            : telosSdkDefinitions.map(({ name }) => ({ id: `mitzo:${name}`, version: 1 })),
      }
    : undefined;
  assertAgentToolRoute(definition as never, 'claude-sdk');
  bindAgentToolSelection(session, definition as never, 'claude-sdk');
  let current = true;
  const assert = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!current) throw Error('retired');
  };
  const server = createTelosSdkServer({
    session,
    registry,
    events: data.events,
    assertCurrent: async (signal) => assert(signal),
    assertCurrentSync: assert,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'offline-telos', version: '1' });
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const value = (result: Awaited<ReturnType<typeof call>>) =>
    JSON.parse((result.content as Array<{ text: string }>)[0].text);
  return {
    ...data,
    session,
    registry,
    client,
    call,
    value,
    assert,
    revoke,
    deny: () => {
      approved = false;
    },
    retire: () => {
      current = false;
    },
    beforeApproval: (fn: () => void) => {
      beforeApproval = fn;
    },
  };
}

it('omits excluded tools and refuses direct MCP invocations', async () => {
  const f = await fixture('excluded');
  expect((await f.client.listTools()).tools).toEqual([]);
  expect((await f.call('TelosListItems', {})).isError).toBe(true);
});

it.each([false, true])(
  'retains exact schemas and permission eligibility (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    const listed = (await f.client.listTools()).tools;
    for (const definition of telosSdkDefinitions) {
      expect(listed.find((t) => t.name === definition.name)?.inputSchema).toEqual({
        type: 'object',
        ...definition.input_schema,
      });
    }
    expect(
      telosSdkPermission(
        'mcp__telos__TelosManageItem',
        { operation: 'read', itemId: 'studio' },
        'client',
        f.registry,
        f.session,
      )?.behavior,
    ).toBe('allow');
    f.session.activeSkillPolicy = new Set(['Read']);
    expect(
      telosSdkPermission(
        'mcp__telos__TelosManageItem',
        { operation: 'read', itemId: 'studio' },
        'client',
        f.registry,
        f.session,
      )?.behavior,
    ).toBe('deny');
  },
);

it.each([false, true])(
  'executes MCP calls on first turn, successor and cold continuation (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    const requests: Options[] = [];
    vi.mocked(query).mockImplementation((request) => {
      requests.push(request.options!);
      return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
    });
    const construct = (cold: boolean) => {
      const controller = new AbortController();
      cleanup.push(() => controller.abort());
      return createOrdinaryLocalVertexSdkQuery({
        options: cold ? { resume: 'planning' } : { sessionId: 'planning' },
        input: new AsyncQueue(),
        controller,
        lifetime: new SdkHookLifetime(),
        sdkSessionId: 'planning',
        cwd: '/fixture',
        authorize: async () => {},
        authorizeSync: () => {},
        adapt: (q) => q as never,
        settings: (selection) => ({ model: selection.model }),
        inputChanged: () => {},
        onUnsent: vi.fn(),
        mcpServers: (state) => ({
          telos: createTelosSdkServer({
            session: f.session,
            registry: f.registry,
            events: f.events,
            runCallback: state.runCallback,
            assertCurrent: async (signal) => {
              f.assert(signal);
              if (state.retired || state.completing) throw Error('retired query');
            },
            assertCurrentSync: (signal) => {
              f.assert(signal);
              if (state.retired || state.completing) throw Error('retired query');
            },
          }),
        }),
      });
    };
    const connect = async () => {
      const server = requests.at(-1)!.mcpServers!.telos as ReturnType<typeof createTelosSdkServer>;
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(a);
      const client = new Client({ name: 'synthetic-provider', version: '1' });
      await client.connect(b);
      cleanup.push(async () => {
        await client.close();
        await server.instance.close();
      });
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('TelosListItems');
      expect((await client.callTool({ name: 'TelosListItems', arguments: {} })).isError).toBe(
        false,
      );
      return client;
    };
    const owner = construct(false);
    const original = await connect();
    await owner.apply({ model: 'synthetic-first' } as never);
    await owner.apply({ model: 'synthetic-successor' } as never);
    await connect();
    // The SDK query has retired the original callback; it cannot execute another effect.
    expect((await original.callTool({ name: 'TelosListItems', arguments: {} })).isError).toBe(true);
    expect(requests.at(-1)).toMatchObject({ resume: 'planning' });
    construct(true);
    await connect();
  },
);

it('recovers an uncertain canonical creation under its original request without a duplicate', async () => {
  const f = await fixture();
  const original = TelosItemStore.prototype.createFeatureGuarded;
  vi.spyOn(TelosItemStore.prototype, 'createFeatureGuarded').mockImplementationOnce(function (
    this: TelosItemStore,
    ...args
  ) {
    original.apply(this, args);
    throw Error('Synthetic response lost after COMMIT');
  });
  const input = {
    requestId: 'uncertain',
    summary: 'Recovered feature',
    intent: 'Recover',
    rationale: 'No duplicates',
    acceptanceCriteria: ['One item'],
    note: 'Offline',
  };
  expect((await f.call('TelosCreateFeature', input)).isError).toBe(true);
  const recovered = f.value(await f.call('TelosCreateFeature', input));
  expect(recovered.ok).toBe(true);
  expect(f.db.prepare('SELECT id FROM items WHERE summary=?').all('Recovered feature')).toEqual([
    { id: recovered.item.id },
  ]);
});

it.each([false, true])(
  'uses the canonical assigned-lead progress handler (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    expect((await f.call('TelosGetItem', { itemId: 'studio' })).isError).toBe(true);
    f.work.execute(
      {
        operation: 'classify',
        itemId: 'studio',
        requestId: 'kind',
        expectedRevision: f.work.read('studio', f.actor).revision,
        kind: 'outcome',
      },
      f.actor,
    );
    const binding = {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'anthropic-claude' as const,
      profileRevision: 'r1',
      model: 'synthetic',
    };
    f.events.upsertSession({ sessionId: 'planning', accountBinding: binding });
    retainTelosWorkRoleContext(
      f.events,
      'planning',
      binding,
      reviewTelosWorkRoleContext({
        work: f.work,
        artifacts: f.artifacts,
        actor: f.actor,
        itemId: 'studio',
        role: 'lead',
        selectedSourceSnapshotIds: [],
        selectedArtifactRefs: [],
      }),
    );
    f.work.execute(
      {
        operation: 'setup_role',
        itemId: 'studio',
        requestId: 'lead',
        expectedRevision: f.work.read('studio', f.actor).revision,
        expectedAssignmentRevision: 0,
        role: 'lead',
        conversationId: 'planning',
      },
      f.actor,
    );
    const read = f.value(await f.call('TelosGetItem', { itemId: 'studio' }));
    expect(read, JSON.stringify(read)).toHaveProperty('item');
    const input = {
      itemId: 'studio',
      requestId: 'progress',
      expectedRevision: read.item.revision,
      note: 'Fixture evidence',
    };
    expect((await f.call('TelosUpdateItem', input)).isError).toBe(false);
    expect((await f.call('TelosUpdateItem', input)).isError).toBe(false);
    expect(
      (await f.call('TelosUpdateItem', { ...input, requestId: 'stale-progress' })).isError,
    ).toBe(true);
  },
);

it('saves, finds and reads artifacts through the SDK, existing HTTP handler and canonical store', async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  const readFile = vi.fn(async () => {
    throw Error('No fixture filesystem access');
  });
  app.use(
    createTelosArtifactRouter({
      dbPath: () => f.dbPath,
      verifyInternal: () => true,
      sessionId: (client) => f.registry.get(client)?.sessionId,
      readFile,
    }),
  );
  let loseResponse = true;
  let retireRead = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const response = await request(app)
        .post(new URL(url).pathname)
        .set(init.headers as Record<string, string>)
        .send(JSON.parse(init.body as string));
      if (loseResponse) {
        loseResponse = false;
        throw Error('Synthetic lost artifact receipt');
      }
      if (retireRead) f.retire();
      return new Response(JSON.stringify(response.body), { status: response.status });
    }),
  );
  const input = {
    itemId: 'studio',
    requestId: 'artifact-save',
    filename: 'sdk.md',
    title: 'SDK artifact',
    content: 'Exact synthetic bytes',
  };
  expect((await f.call('TelosSaveArtifact', input)).isError).toBe(true);
  const saved = f.value(await f.call('TelosSaveArtifact', input));
  expect(saved.artifact.revision).toBe(1);
  const found = f.value(await f.call('TelosFindArtifacts', { itemId: 'studio' }));
  expect(found.artifacts.some((a: { id: string }) => a.id === saved.artifact.id)).toBe(true);
  const read = f.value(await f.call('TelosReadArtifact', { id: saved.artifact.id, revision: 1 }));
  expect(read.artifact.content).toBe(input.content);
  expect(readFile).not.toHaveBeenCalled();
  retireRead = true;
  const revoked = await f.call('TelosReadArtifact', { id: saved.artifact.id, revision: 1 });
  expect(revoked.isError).toBe(true);
  expect(JSON.stringify(revoked)).not.toContain(input.content);
});

it.each([false, true])(
  'executes canonical backlog through the actual SDK MCP server (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    expect((await f.client.listTools()).tools.map((t) => t.name)).toContain('TelosCreateFeature');
    const input = {
      requestId: 'sdk-feature',
      summary: 'Offline feature',
      intent: 'Verify SDK execution',
      rationale: 'Canonical reuse',
      acceptanceCriteria: ['Receipt retained'],
      note: 'Disposable fixture',
    };
    const created = f.value(await f.call('TelosCreateFeature', input));
    expect(created.ok).toBe(true);
    expect(created.item.workLevel).toBe('feature');
    expect(f.value(await f.call('TelosCreateFeature', input)).item.id).toBe(created.item.id);
    const read = f.value(
      await f.call('TelosManageItem', { operation: 'read', itemId: created.item.id }),
    );
    const update = {
      operation: 'update',
      itemId: created.item.id,
      requestId: 'sdk-update',
      expectedRevision: read.item.revision,
      note: 'Synthetic evidence',
    };
    expect(f.value(await f.call('TelosManageItem', update)).ok).toBe(true);
    expect(
      (await f.call('TelosManageItem', { ...update, requestId: 'stale-update' })).isError,
    ).toBe(true);
    const list = f.value(await f.call('TelosSearchItems', { query: 'Offline feature' }));
    expect(JSON.stringify(list)).toContain(created.item.id);
    const parent = f.value(
      await f.call('TelosManageItem', { operation: 'read', itemId: created.item.id }),
    ).item;
    const childInput = {
      ...input,
      requestId: 'sdk-slice',
      summary: 'Offline slice',
      parentId: parent.id,
      expectedParentRevision: parent.revision,
    };
    const child = f.value(await f.call('TelosCreateChild', childInput)).item;
    expect(child.workLevel).toBe('slice');
    expect(f.value(await f.call('TelosCreateChild', childInput)).item.id).toBe(child.id);
    expect(
      (await f.call('TelosCreateChild', { ...childInput, requestId: 'stale-parent' })).isError,
    ).toBe(true);
    const complete = async (itemId: string, requestId: string) => {
      const read = f.value(await f.call('TelosManageItem', { operation: 'read', itemId }));
      return f.call('TelosManageItem', {
        operation: 'update',
        itemId,
        requestId,
        expectedRevision: read.item.revision,
        status: 'completed',
        note: 'Synthetic evidence verified',
      });
    };
    expect((await complete(parent.id, 'blocked-parent')).isError).toBe(true);
    expect((await complete(child.id, 'complete-child')).isError).toBe(false);
    expect((await complete(parent.id, 'complete-parent')).isError).toBe(false);
  },
);

it.each(['denied', 'revoked', 'operator-revoked', 'cancelled', 'restricted'] as const)(
  'fences %s mutations at the SDK callback and canonical effect',
  async (failure) => {
    const f = await fixture();
    if (failure === 'denied') f.deny();
    if (failure === 'revoked') f.beforeApproval(f.retire);
    if (failure === 'operator-revoked') f.beforeApproval(f.revoke);
    if (failure === 'cancelled') f.session.abortController.abort();
    if (failure === 'restricted') f.session.activeSkillPolicy = new Set(['Read']);
    const result = await f.call('TelosCreateFeature', {
      requestId: 'refused',
      summary: 'Must not exist',
      intent: 'No effect',
      rationale: 'Fence',
      acceptanceCriteria: ['Absent'],
      note: 'Synthetic',
    });
    expect(result.isError).toBe(true);
    expect(f.db.prepare('SELECT id FROM items WHERE summary=?').all('Must not exist')).toEqual([]);
  },
);
