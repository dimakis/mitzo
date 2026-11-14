import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as artifactReader from '../openshell-artifact-reader.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import express from 'express';
import request from 'supertest';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';
import { TelosItemStore } from '../telos-item-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import * as harness from '@mitzo/harness';
import { createTelosSdkServer, telosSdkPermission } from '../telos-sdk-tools.js';
import { telosSdkDefinitions } from '../telos-sdk-definitions.js';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
import { retainedCallbackOutcome } from '../turn-callbacks.js';
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
  let expire = false;
  let beforeApproval = () => {};
  let afterCurrent = () => {};
  registry.register('client', {
    sessionId: 'planning',
    cwd: dirname(data.dbPath),
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
            const clock = expire
              ? vi.spyOn(Date, 'now').mockReturnValue(Number(event.expiresAt) + 1)
              : undefined;
            try {
              resolvePending(permId, approved ? 'once' : 'deny');
            } finally {
              clock?.mockRestore();
            }
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
  let outcome: ReturnType<typeof retainedCallbackOutcome>;
  const assert = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!current) throw Error('retired');
  };
  const server = createTelosSdkServer({
    session,
    registry,
    events: data.events,
    runCallback: async (work) => {
      const result = await work();
      outcome =
        result !== null && typeof result === 'object' ? retainedCallbackOutcome(result) : undefined;
      return result;
    },
    assertCurrent: async (signal) => {
      assert(signal);
      afterCurrent();
    },
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
    outcome: () => outcome,
    expireApproval: () => {
      expire = true;
    },
    deny: () => {
      approved = false;
    },
    retire: () => {
      current = false;
    },
    beforeApproval: (fn: () => void) => {
      beforeApproval = fn;
    },
    afterCurrent: (fn: () => void) => {
      afterCurrent = fn;
    },
  };
}

function ordinaryQuery(f: Awaited<ReturnType<typeof fixture>>, cold = false) {
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  return createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
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
}

function assignLead(f: Awaited<ReturnType<typeof fixture>>) {
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
}

async function ordinaryClient(f: Awaited<ReturnType<typeof fixture>>) {
  const events = new AsyncQueue<Record<string, unknown>>();
  cleanup.push(() => events.close());
  let options!: Options;
  vi.mocked(query).mockImplementation((request) => {
    options = request.options!;
    return {
      close: vi.fn(),
      [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    } as never;
  });
  const owner = ordinaryQuery(f);
  const server = options.mcpServers!.telos as ReturnType<typeof createTelosSdkServer>;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'settlement-provider', version: '1' });
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const terminal = () => {
    events.push({ type: 'result', session_id: 'planning' });
    return owner.query[Symbol.asyncIterator]().next();
  };
  return { client, terminal };
}

it.each([
  'denied',
  'denied-native',
  'missing-role',
  'missing-lead',
  'missing-control',
  'stale-item',
  'stale-native-item',
  'stale-parent',
  'unknown',
  'rolled-back-write',
])('retains refusal evidence through the SDK terminal result (%s)', async (refusal) => {
  const f = await fixture();
  if (refusal === 'stale-native-item' || refusal === 'denied-native') assignLead(f);
  const before = f.db.prepare('SELECT * FROM items ORDER BY id').all();
  const sdk = await ordinaryClient(f);
  const feature = {
    requestId: 'refused-feature',
    summary: 'Must not exist',
    intent: 'Refusal',
    rationale: 'No effect',
    acceptanceCriteria: ['No effect'],
    note: 'Offline',
  };
  const update = {
    itemId: 'studio',
    requestId: 'refused-update',
    expectedRevision: '0'.repeat(64),
    note: 'No effect',
  };
  if (refusal === 'denied' || refusal === 'denied-native') f.deny();
  if (refusal === 'unknown') {
    const original = TelosItemStore.prototype.createFeatureGuarded;
    vi.spyOn(TelosItemStore.prototype, 'createFeatureGuarded').mockImplementation(function (
      this: TelosItemStore,
      ...args
    ) {
      original.apply(this, args);
      // Even a familiar message after COMMIT cannot manufacture refusal evidence.
      throw Error('Telos item changed; simulated uncertain storage failure');
    });
  }
  if (refusal === 'rolled-back-write') {
    f.db.exec(`CREATE TRIGGER refused_write AFTER INSERT ON items BEGIN
      SELECT RAISE(ABORT, 'injected write failure'); END`);
    vi.spyOn(TelosItemStore.prototype, 'createFeatureGuarded');
  }
  const [name, input]: [string, Record<string, unknown>] =
    refusal === 'missing-lead'
      ? [
          'TelosStartSlice',
          { requestId: 'no-lead', childItemId: 'child', mode: 'start', predecessorAttemptId: null },
        ]
      : refusal === 'missing-control'
        ? [
            'TelosWorkControl',
            { command: { operation: 'release', controlId: 'none', requestId: 'no-role' } },
          ]
        : refusal === 'missing-role' || refusal === 'denied-native'
          ? ['TelosUpdateItem', update]
          : refusal === 'stale-native-item'
            ? ['TelosUpdateItem', update]
            : refusal === 'stale-item'
              ? ['TelosManageItem', { ...update, operation: 'update' }]
              : refusal === 'stale-parent'
                ? [
                    'TelosCreateChild',
                    { ...feature, parentId: 'studio', expectedParentRevision: '0'.repeat(64) },
                  ]
                : ['TelosCreateFeature', feature];
  const result = await sdk.client.callTool({
    name,
    arguments: input,
  });
  expect(result.isError).toBe(true);
  if (refusal.startsWith('stale-')) expect(JSON.stringify(result)).toContain('Telos item changed;');
  if (refusal === 'unknown') {
    expect(f.db.prepare('SELECT * FROM items ORDER BY id').all()).toHaveLength(before.length + 1);
    expect(TelosItemStore.prototype.createFeatureGuarded).toHaveBeenCalledTimes(1);
    await expect(sdk.terminal()).rejects.toMatchObject({ code: 'callbacks_failed' });
  } else if (refusal === 'rolled-back-write') {
    expect(f.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    expect(TelosItemStore.prototype.createFeatureGuarded).toHaveBeenCalledTimes(1);
    await expect(sdk.terminal()).rejects.toMatchObject({ code: 'callbacks_failed' });
  } else {
    expect(f.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    await expect(sdk.terminal()).resolves.toMatchObject({ value: { type: 'result' } });
  }
});

it.each(['archive-revision', 'classification', 'archived-edit', 'archived-child'] as const)(
  'settles canonical %s refusal with valid revisions and no canonical changes',
  async (refusal) => {
    const f = await fixture();
    const feature = {
      requestId: 'existing-feature',
      summary: 'Existing feature',
      intent: 'Existing',
      rationale: 'Regression',
      acceptanceCriteria: ['No refused changes'],
      note: 'Offline',
    };
    const created = f.value(await f.call('TelosCreateFeature', feature));
    const itemId = created.item.id;
    const read = () => f.call('TelosManageItem', { operation: 'read', itemId }).then(f.value);
    if (refusal.startsWith('archived-')) {
      const current = await read();
      expect(
        (
          await f.call('TelosManageItem', {
            operation: 'archive',
            itemId,
            requestId: 'archive-existing',
            expectedRevision: current.lifecycle.revision,
          })
        ).isError,
      ).toBe(false);
    }
    const current = await read();
    const stale = '0'.repeat(64);
    expect(stale).not.toBe(current.lifecycle.revision);
    expect(stale).not.toBe(current.item.revision);
    const snapshot = () =>
      [
        'items',
        'history',
        'telos_item_updates',
        'telos_work_kinds',
        'telos_work_lifecycle',
        'telos_work_lifecycle_history',
        'telos_work_lifecycle_commands',
      ].map((table) => ({
        table,
        rows: f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      }));
    const before = snapshot();
    const sdk = await ordinaryClient(f);
    const [name, input]: [string, Record<string, unknown>] =
      refusal === 'archive-revision'
        ? [
            'TelosManageItem',
            { operation: 'archive', itemId, requestId: 'stale-archive', expectedRevision: stale },
          ]
        : refusal === 'archived-child'
          ? [
              'TelosCreateChild',
              {
                ...feature,
                requestId: 'refused-child',
                parentId: itemId,
                expectedParentRevision: current.item.revision,
              },
            ]
          : [
              'TelosManageItem',
              {
                operation: 'edit',
                itemId,
                requestId: 'refused-edit',
                expectedRevision: current.item.revision,
                note: 'Must not change',
                ...(refusal === 'classification'
                  ? { workLevel: 'outcome' }
                  : { summary: 'Must not change' }),
              },
            ];
    const result = await sdk.client.callTool({ name, arguments: input });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Invalid Telos backlog input');
    expect(JSON.stringify(result)).toContain(
      refusal === 'archive-revision'
        ? 'Work revision conflict;'
        : refusal === 'classification'
          ? 'already classified;'
          : 'Work is archived;',
    );
    expect(snapshot()).toEqual(before);
    await expect(sdk.terminal()).resolves.toMatchObject({ value: { type: 'result' } });
  },
);

it.each(
  ([false, true] as const).flatMap((explicit) =>
    (['fetch', 'cleanup'] as const).flatMap((phase) =>
      (['retired', 'skill', 'operator'] as const).map(
        (revocation) => [explicit, phase, revocation] as const,
      ),
    ),
  ),
)(
  'fences inbox/read delivery and preserves mutation ACK (explicit=%s phase=%s revocation=%s)',
  async (explicit, phase, revocation) => {
    let revoke = () => {};
    if (phase === 'cleanup') {
      const guarded = harness.runGuardedTool;
      vi.spyOn(harness, 'runGuardedTool').mockImplementation((options, execute) =>
        guarded(
          {
            ...options,
            onSettled: (observation) => {
              options.onSettled?.(observation);
              if (observation.outcome === 'completed') revoke();
            },
          },
          execute,
        ),
      );
    }
    for (const operation of ['inbox', 'read', 'release'] as const) {
      const f = await fixture(explicit);
      assignLead(f);
      const sdk = phase === 'cleanup' ? await ordinaryClient(f) : undefined;
      revoke = () => {
        if (revocation === 'retired') f.retire();
        if (revocation === 'operator') f.revoke();
        if (revocation === 'skill') f.session.activeSkillPolicy = new Set(['Read']);
      };
      const receipt = {
        version: 1,
        controlId: 'private-control',
        coordinatorItemId: 'studio',
        coordinatorConversationId: 'planning',
        priorityItemId: 'priority',
        scope: 'publication',
        stage: 'released',
        publicationRevalidation: 'required',
        targets: [],
        history: [],
      };
      let release!: () => void;
      const deferred = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const checkpoint = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const fetch = vi.fn(async () => {
        reached();
        await deferred;
        return new Response(JSON.stringify(operation === 'inbox' ? [receipt] : receipt));
      });
      vi.stubGlobal('fetch', fetch);
      const command =
        operation === 'inbox'
          ? { operation, itemId: 'studio' }
          : operation === 'release'
            ? { operation, controlId: receipt.controlId, requestId: 'release' }
            : { operation, controlId: receipt.controlId };
      const pending = sdk
        ? sdk.client.callTool({ name: 'TelosWorkControl', arguments: { command } })
        : f.call('TelosWorkControl', { command });
      await checkpoint;
      if (phase === 'fetch') revoke();
      release();
      const result = await pending;
      expect(result.isError).toBe(operation !== 'release');
      if (operation !== 'release') expect(JSON.stringify(result)).not.toContain(receipt.controlId);
      else expect(f.value(result)).toEqual(receipt);
      if (sdk) await expect(sdk.terminal()).resolves.toMatchObject({ value: { type: 'result' } });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(
  [false, true].flatMap((explicit) =>
    (
      [
        ['TelosListItems', {}],
        ['TelosSearchItems', { query: 'studio' }],
        ['TelosManageItem', { operation: 'read', itemId: 'studio' }],
        ['TelosGetItem', { itemId: 'studio' }],
        ['TelosFindArtifacts', { itemId: 'studio' }],
      ] as Array<[string, Record<string, unknown>]>
    ).map(([name, input]) => [explicit, name, input] as const),
  ),
)(
  'withholds retained %s/%s read results after guard settlement revokes authority',
  async (explicit, name, input) => {
    const f = await fixture(explicit);
    assignLead(f);
    if (name === 'TelosFindArtifacts')
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ ok: true, artifacts: [f.material] }))),
      );
    const before = await f.call(name, input);
    expect(before.isError).toBe(false);
    expect(JSON.stringify(before)).toContain('studio');
    const guarded = harness.runGuardedTool;
    vi.spyOn(harness, 'runGuardedTool').mockImplementation((options, execute) =>
      guarded(
        {
          ...options,
          onSettled: (observation) => {
            options.onSettled?.(observation);
            if (observation.outcome === 'completed') f.retire();
          },
        },
        execute,
      ),
    );
    const result = await f.call(name, input);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('studio');
    expect(f.outcome()).toBe('settled');
  },
);

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
    const prompts: AsyncIterable<SDKUserMessage>[] = [];
    vi.mocked(query).mockImplementation((request) => {
      requests.push(request.options!);
      if (typeof request.prompt === 'string') throw Error('Expected original SDK input stream');
      prompts.push(request.prompt);
      return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
    });
    const construct = (cold: boolean) => ordinaryQuery(f, cold);
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
    await owner.apply({ model: 'synthetic-first' } as never);
    // A successor can resume history only after an input crossed the SDK stream.
    owner.push({
      type: 'user',
      session_id: 'planning',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Original dispatched input' },
    });
    expect(await prompts[0][Symbol.asyncIterator]().next()).toMatchObject({
      done: false,
      value: { message: { content: 'Original dispatched input' } },
    });
    const original = await connect();
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
    assignLead(f);
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

it('saves through the guarded canonical owner and finds/reads through the existing HTTP handler', async () => {
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
  const save = TelosArtifactStore.prototype.saveGuarded;
  vi.spyOn(TelosArtifactStore.prototype, 'saveGuarded').mockImplementationOnce(function (
    this: TelosArtifactStore,
    ...args
  ) {
    save.apply(this, args);
    throw Error('Synthetic lost artifact commit receipt');
  });
  let retireRead = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const response = await request(app)
        .post(new URL(url).pathname)
        .set(init.headers as Record<string, string>)
        .send(JSON.parse(init.body as string));
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
  'settles expired mutations through the ordinary query callback owner (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    assignLead(f);
    const read = f.value(await f.call('TelosGetItem', { itemId: 'studio' }));
    const before = f.db.prepare('SELECT * FROM items ORDER BY id').all();
    const artifacts = f.artifacts.list({ itemId: 'studio' });
    const events = new AsyncQueue<Record<string, unknown>>();
    cleanup.push(() => events.close());
    let options!: Options;
    vi.mocked(query).mockImplementation((request) => {
      options = request.options!;
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      } as never;
    });
    const owner = ordinaryQuery(f);
    const server = options.mcpServers!.telos as ReturnType<typeof createTelosSdkServer>;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: 'expiring-provider', version: '1' });
    await client.connect(b);
    cleanup.push(async () => {
      await client.close();
      await server.instance.close();
    });
    f.expireApproval();
    const update = {
      itemId: 'studio',
      requestId: 'expired-progress',
      expectedRevision: read.item.revision,
      note: 'Must not be saved',
    };
    for (const [name, input] of [
      [
        'TelosCreateFeature',
        {
          requestId: 'expired-feature',
          summary: 'Must not exist',
          intent: 'Expiry',
          rationale: 'Known refusal',
          acceptanceCriteria: ['No effect'],
          note: 'Offline',
        },
      ],
      ['TelosManageItem', { ...update, operation: 'update' }],
      ['TelosUpdateItem', update],
      [
        'TelosSaveArtifact',
        {
          itemId: 'studio',
          requestId: 'expired-artifact',
          filename: 'expired.md',
          title: 'Must not be saved',
          content: 'Unapproved draft',
        },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError).toBe(true);
      expect(f.value(result).failure).toMatchObject({
        code: 'approval_expired',
        phase: 'approval',
        effectStatus: 'not_started',
      });
    }
    expect(f.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    expect(f.artifacts.list({ itemId: 'studio' })).toEqual(artifacts);
    events.push({ type: 'result', session_id: 'planning' });
    await expect(owner.query[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { type: 'result', session_id: 'planning' },
    });
  },
);

it.each([undefined, 1])(
  'refuses retained private artifact bytes through SDK and HTTP (revision=%s)',
  async (revision) => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    app.use(
      createTelosArtifactRouter({
        dbPath: () => f.dbPath,
        verifyInternal: () => true,
        sessionId: (client) => f.registry.get(client)?.sessionId,
        readFile: async () => {
          throw Error('No fixture filesystem access');
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const response = await request(app)
          .post(new URL(url).pathname)
          .set(init.headers as Record<string, string>)
          .send(JSON.parse(init.body as string));
        return new Response(JSON.stringify(response.body), { status: response.status });
      }),
    );
    const input = { id: f.material.id, ...(revision === undefined ? {} : { revision }) };
    expect(f.value(await f.call('TelosReadArtifact', input)).artifact.content).toBe(
      'The reviewed panel layout.',
    );
    f.db.prepare("UPDATE items SET profile='lifeops' WHERE id='studio'").run();
    const hydrate = vi.spyOn(TelosArtifactStore.prototype, 'readBoundedRevision');
    const result = await f.call('TelosReadArtifact', input);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('The reviewed panel layout.');
    expect(hydrate).not.toHaveBeenCalled();
  },
);

it.each([
  [false, undefined, 'authority'],
  [true, 1, 'authority'],
  [false, 1, 'cleanup'],
  [true, undefined, 'cleanup'],
] as const)(
  'withholds artifact bytes when eligibility changes at delivery (explicit=%s revision=%s phase=%s)',
  async (explicit, revision, phase) => {
    const f = await fixture(explicit);
    const app = express();
    app.use(express.json());
    app.use(
      createTelosArtifactRouter({
        dbPath: () => f.dbPath,
        verifyInternal: () => true,
        sessionId: (client) => f.registry.get(client)?.sessionId,
        readFile: async () => {
          throw Error('No fixture filesystem access');
        },
      }),
    );
    let responseReady = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const response = await request(app)
          .post(new URL(url).pathname)
          .set(init.headers as Record<string, string>)
          .send(JSON.parse(init.body as string));
        expect(response.body.artifact.content).toBe('The reviewed panel layout.');
        responseReady = true;
        return new Response(JSON.stringify(response.body), { status: response.status });
      }),
    );
    const makePrivate = () => {
      if (responseReady) f.db.prepare("UPDATE items SET profile='lifeops' WHERE id='studio'").run();
    };
    if (phase === 'authority') f.afterCurrent(makePrivate);
    else {
      const guarded = harness.runGuardedTool;
      vi.spyOn(harness, 'runGuardedTool').mockImplementation((options, execute) =>
        guarded(
          {
            ...options,
            onSettled: (observation) => {
              options.onSettled?.(observation);
              if (observation.outcome === 'completed') makePrivate();
            },
          },
          execute,
        ),
      );
    }
    const result = await f.call('TelosReadArtifact', {
      id: f.material.id,
      ...(revision === undefined ? {} : { revision }),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('The reviewed panel layout.');
    expect(responseReady).toBe(true);
    expect(f.outcome()).toBe('settled');
  },
);

it.each(['cancel', 'operator', 'runtime', 'skill', 'workspace'] as const)(
  'prevents artifact save after %s authority changes during workspace reading',
  async (failure) => {
    const f = await fixture();
    writeFileSync(join(f.session.cwd!, 'report.md'), 'Disposable report');
    let entered!: () => void;
    let resume!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const read = artifactReader.captureLocalArtifactFile;
    vi.spyOn(artifactReader, 'captureLocalArtifactFile').mockImplementation(async (...args) => {
      const captured = await read(...args);
      entered();
      await release;
      return captured;
    });
    const pending = f.call('TelosSaveArtifact', {
      itemId: 'studio',
      requestId: 'interrupted-file-save',
      filename: 'report.md',
      title: 'Disposable report',
      path: 'report.md',
    });
    await reading;
    if (failure === 'cancel') f.session.abortController.abort();
    if (failure === 'operator') f.revoke();
    if (failure === 'runtime') f.retire();
    if (failure === 'skill') f.session.activeSkillPolicy = new Set(['Read']);
    if (failure === 'workspace') f.session.cwd = '/replaced-workspace';
    resume();
    expect((await pending).isError).toBe(true);
    expect(
      f.artifacts.list({ itemId: 'studio' }).filter((a) => a.filename === 'report.md'),
    ).toEqual([]);
    expect(
      f.db
        .prepare('SELECT * FROM telos_artifact_save_requests WHERE request_id=?')
        .all('interrupted-file-save'),
    ).toEqual([]);
  },
);

it('saves a workspace file through SDK and the existing guarded file/commit owner', async () => {
  const f = await fixture(true);
  writeFileSync(join(f.session.cwd!, 'report.md'), 'Disposable report');
  const input = {
    itemId: 'studio',
    requestId: 'workspace-save',
    filename: 'report.md',
    title: 'Disposable report',
    path: 'report.md',
  };
  const saved = f.value(await f.call('TelosSaveArtifact', input));
  expect(saved.artifact.revision).toBe(1);
  expect(f.artifacts.read(saved.artifact.id, 1).bytes.toString()).toBe('Disposable report');
  writeFileSync(join(f.session.cwd!, 'report.md'), 'Changed after receipt');
  expect(f.value(await f.call('TelosSaveArtifact', input))).toEqual(saved);
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
