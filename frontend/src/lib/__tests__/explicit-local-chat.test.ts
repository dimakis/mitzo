import { expect, it } from 'vitest';
import type { ExplicitLocalInventory } from '../explicit-local-chat';
import {
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  profileBuilderDefinition,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import { sha256Hex } from '../browser-crypto';
import {
  buildLocalFirstCommand,
  normalizeLocalInventory,
  prepareLocalFirstCommand,
  prepareLocalContinuationCommand,
  ExplicitLocalInventorySchema,
} from '../explicit-local-chat';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
import { evaluateChatRuntimeSelection } from '../chat-runtime-selection';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';

it('keeps unsupported recipe intent visible and refuses a plain-only adapter without changing it to none', () => {
  const data = localInventoryFixture();
  const definition = {
    ...data.agentProfiles[0].definition,
    contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'original' },
  };
  const profile = {
    ...data.agentProfiles[0],
    definition,
    contentHash: sha256Hex(JSON.stringify(definition)),
  };
  const agent = { profileId: profile.profileId, revision: profile.revision };
  const catalog = ExplicitLocalInventorySchema.parse({
    ...data,
    agentProfiles: [profile],
    routes: data.routes.map((route) => ({
      ...route,
      agentProfiles: [],
      agentProfileRejections: [{ agent, reason: 'native_context_unavailable' }],
    })),
  });
  const intent = {
    ...createChatRuntimeSelection(),
    agentProfile: agent,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: catalog.capabilityRevision,
  };
  const retained = structuredClone(intent);
  const result = prepareLocalFirstCommand(intent, catalog, {
    clientMsgId: 'first',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent',
    text: 'Inspect',
  });
  expect(result.request).toBeNull();
  expect(result.reason).toContain('context recipes are unavailable');
  expect(intent).toEqual(retained);
});

it('retains the selected recipe and blocks OpenShell without its preset while Local remains eligible', async () => {
  const { ordinaryRuntimeInventoryFixture } =
    await import('../../test-utils/ordinary-runtime-inventory-fixture');
  const data = ordinaryRuntimeInventoryFixture();
  const definition = {
    ...data.agentProfiles[0].definition,
    contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'missing' },
  };
  const profile = {
    ...data.agentProfiles[0],
    definition,
    contentHash: sha256Hex(JSON.stringify(definition)),
  };
  const agent = { profileId: profile.profileId, revision: profile.revision };
  const catalog = ExplicitLocalInventorySchema.parse({
    ...data,
    agentProfiles: [profile],
    routes: data.routes.map((route) => ({
      ...route,
      agentProfiles: route.targetId === 'sandbox' ? [] : [agent],
      agentProfileRejections:
        route.targetId === 'sandbox'
          ? [{ agent, reason: 'sandbox_context_preset_unconfigured' }]
          : [],
    })),
  });
  const selection = {
    ...createChatRuntimeSelection(),
    agentProfile: agent,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    execution: { location: 'openshell' as const, targetId: 'sandbox' },
    capabilityRevision: catalog.capabilityRevision,
  };
  const before = structuredClone(selection);
  const readiness = evaluateChatRuntimeSelection(selection, normalizeLocalInventory(catalog));
  expect(readiness.ready).toBe(false);
  expect(readiness.issues.find((issue) => issue.code === 'agent_unavailable')?.message).toContain(
    'context preset is not configured',
  );
  expect(selection).toEqual(before);
  expect(
    evaluateChatRuntimeSelection(
      { ...selection, execution: { location: 'local', targetId: 'mac' } },
      normalizeLocalInventory(catalog),
    ).ready,
  ).toBe(true);
});

it.each(['builtin', 'workspace', 'contexgin'] as const)(
  'decodes the published %s catalog and emits exact namespace/recipe intent',
  (source) => {
    const data = localInventoryFixture();
    const definition =
      source === 'builtin'
        ? profileBuilderDefinition
        : {
            ...data.agentProfiles[0].definition,
            contextRecipe:
              source === 'workspace'
                ? {
                    version: 1 as const,
                    source,
                    files: ['context.md'],
                    tokenBudget: 1000,
                    required: [],
                    excluded: [],
                  }
                : { version: 1 as const, source, agentName: 'preset' },
          };
    const profile: AgentLibraryVersion = {
      ...(source === 'builtin' ? { kind: 'builtin' as const } : {}),
      profileId: source === 'builtin' ? PROFILE_BUILDER_ID : 'agent',
      revision: source === 'builtin' ? PROFILE_BUILDER_REVISION : 1,
      definition,
      contentHash: sha256Hex(JSON.stringify(definition)),
    };
    const catalog = ExplicitLocalInventorySchema.parse({ ...data, agentProfiles: [profile] });
    const agentProfile = {
      profileId: profile.profileId,
      revision: profile.revision,
      ...(profile.kind ? { kind: profile.kind } : {}),
    };
    const intent = {
      ...createChatRuntimeSelection(),
      agentProfile,
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
      execution: { location: 'local' as const, targetId: 'mac' },
      capabilityRevision: catalog.capabilityRevision,
    };
    const args = {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent' as const,
      text: 'Inspect',
    };
    const first = prepareLocalFirstCommand(intent, catalog, args).request!;
    expect(first.selection.agent).toEqual(agentProfile);
    expect(first.selection.context).toEqual(
      source === 'builtin'
        ? { source: 'none', revision: null }
        : { source, revision: sha256Hex(JSON.stringify(definition.contextRecipe)) },
    );
    const next = prepareLocalContinuationCommand(intent, catalog, {
      ...args,
      clientMsgId: 'next',
      sessionId: 'retained',
      retainedAgentProfile: profile,
    }).request!;
    expect(next.selection.agent).toEqual(first.selection.agent);
    expect(next.selection.context).toEqual(first.selection.context);
  },
);

it('refuses changed pinned recipe defaults and unavailable packs without sending context none', () => {
  const data = localInventoryFixture();
  const original = {
    ...data.agentProfiles[0],
    definition: {
      ...data.agentProfiles[0].definition,
      contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'original' },
    },
  };
  original.contentHash = sha256Hex(JSON.stringify(original.definition));
  const changed = {
    ...original,
    definition: {
      ...original.definition,
      contextRecipe: { ...original.definition.contextRecipe, agentName: 'changed' },
    },
  };
  changed.contentHash = sha256Hex(JSON.stringify(changed.definition));
  const catalog = ExplicitLocalInventorySchema.parse({ ...data, agentProfiles: [changed] });
  const intent = {
    ...createChatRuntimeSelection(),
    agentProfile: { profileId: 'agent', revision: 1 },
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: catalog.capabilityRevision,
  };
  const args = {
    sessionId: 'original-session',
    clientMsgId: 'next',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent' as const,
    text: 'Continue',
    retainedAgentProfile: original,
  };
  const result = prepareLocalContinuationCommand(intent, catalog, args);
  expect(result.request).toBeNull();
  expect(result.reason).toMatch(/pinned agent snapshot changed/i);
  const packs: AgentLibraryVersion = {
    ...original,
    definition: {
      ...original.definition,
      contextRecipe: {
        version: 2,
        source: 'packs',
        tokenBudget: 1000,
        packs: [{ id: 'pack', revision: 1, hash: 'a'.repeat(64) }],
      },
    },
  };
  packs.contentHash = sha256Hex(JSON.stringify(packs.definition));
  expect(ExplicitLocalInventorySchema.safeParse({ ...data, agentProfiles: [packs] }).success).toBe(
    false,
  );
  const rawCatalog = { ...catalog, agentProfiles: [packs] };
  const unavailable = prepareLocalFirstCommand(intent, rawCatalog, {
    ...args,
    retainedAgentProfile: undefined,
  });
  expect(unavailable.request).toBeNull();
  expect(unavailable.reason).toContain('trusted native continuation barrier');
});
it('preserves server location explanations and translates configured reason codes', () => {
  const data = localInventoryFixture();
  expect(normalizeLocalInventory(data).locations[0].reason).toBe(
    'OpenShell execution choices are not available yet.',
  );
  data.locations[0].reason = 'The selected OpenShell target is offline.';
  expect(normalizeLocalInventory(data).locations[0].reason).toBe(data.locations[0].reason);
});
it('keeps OpenShell unavailable rather than choosing the configured Local route', () => {
  const data = localInventoryFixture();
  const intent = createChatRuntimeSelection();
  expect(
    buildLocalFirstCommand(intent, data, {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent',
      text: 'Inspect',
    }),
  ).toBeNull();
  expect(intent.execution.location).toBe('openshell');
});
it('requires published revision, explicit thinking and ready exact selected route', () => {
  const data = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const args = {
    clientMsgId: 'first',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent' as const,
    text: 'Inspect',
  };
  const result = buildLocalFirstCommand(intent, data, args)!;
  expect(result.runtime.account).toEqual(data.accounts[0].account);
  expect(result.selection.agent).toEqual(intent.agentProfile);
  expect(result.payload).toEqual({ text: 'Inspect' });
  expect(
    buildLocalFirstCommand(
      { ...intent, account: { ...intent.account, reasoningEffort: null } },
      data,
      args,
    ),
  ).toBeNull();
  expect(buildLocalFirstCommand({ ...intent, capabilityRevision: 'older' }, data, args)).toBeNull();
  expect(buildLocalFirstCommand({ ...intent, agentProfile: null }, data, args)).toBeNull();
  expect(
    buildLocalFirstCommand(
      { ...intent, agentProfile: { profileId: 'agent', revision: 2 } },
      data,
      args,
    ),
  ).toBeNull();
  expect(normalizeLocalInventory(data).locations[0].available).toBe(false);
});
it('refuses builtin selection before request construction even when the user-library ID and revision collide', () => {
  const data = localInventoryFixture();
  const selection = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: {
      kind: 'builtin',
      profileId: 'agent',
      revision: 1,
    } as import('@mitzo/protocol').AgentProfileSelection,
  };
  expect(
    buildLocalFirstCommand(selection, data, {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent',
      text: 'Inspect',
    }),
  ).toBeNull();
  expect(selection.agentProfile).toHaveProperty('kind', 'builtin');
});

it('bounds the entire UTF8 Local envelope and exposes a recovery reason without dropping attachments', () => {
  const data = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const input = {
    clientMsgId: '11111111-1111-4111-8111-111111111111',
    repositoryWorkspaceId: '22222222-2222-4222-8222-222222222222',
    mode: 'agent' as const,
    text: 'é'.repeat(300000),
    images: [{ data: 'AAAA'.repeat(120000), mediaType: 'image/jpeg' }],
  };
  expect(input.text.length + input.images[0].data.length).toBeLessThan(1048576);
  const result = prepareLocalFirstCommand(intent, data, input);
  expect(result.request).toBeNull();
  expect(result.reason).toMatch(/Remove or resize attachments, or shorten/);
  expect(input.images).toHaveLength(1);
  expect(
    prepareLocalFirstCommand(intent, data, { ...input, text: 'Shortened prompt' }).request,
  ).not.toBeNull();
});

it('prepares OpenShell with its native route revision while the draft reviews the combined inventory', async () => {
  const { ordinaryRuntimeInventoryFixture } =
    await import('../../test-utils/ordinary-runtime-inventory-fixture');
  const data = ordinaryRuntimeInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'openshell' as const, targetId: 'sandbox' },
    capabilityRevision: data.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const request = prepareLocalFirstCommand(intent, data, {
    clientMsgId: 'sandbox-first',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    mode: 'agent',
    text: 'Inspect sandbox',
  }).request;
  expect(request).toMatchObject({
    runOn: 'openshell',
    capabilityRevision: 'sandbox-caps-r1',
    runtime: { targetId: 'sandbox', account: data.accounts[0].account },
  });
  expect(intent.capabilityRevision).toBe('combined-caps-r1');
});

it('keeps route locations distinct when independently configured targets reuse an ID', () => {
  const data: ExplicitLocalInventory = localInventoryFixture();
  const local = data.targets[0];
  data.targets.push({ ...local, location: 'openshell', label: 'OpenShell' });
  data.routes[0] = { ...data.routes[0], location: 'local', capabilityRevision: 'local-revision' };
  data.routes.push({
    ...data.routes[0],
    location: 'openshell',
    capabilityRevision: 'shell-revision',
  });
  expect(
    normalizeLocalInventory(ExplicitLocalInventorySchema.parse(data)).routes.map(
      (route) => route.location,
    ),
  ).toEqual(['local', 'openshell']);
  data.locations[0] = { location: 'openshell', status: 'configured' };
  const result = prepareLocalFirstCommand(
    {
      ...createChatRuntimeSelection(),
      execution: { location: 'openshell', targetId: local.targetId },
      capabilityRevision: data.capabilityRevision,
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
      agentProfile: { profileId: 'agent', revision: 1 },
    },
    data,
    {
      clientMsgId: 'first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent',
      text: 'Inspect',
    },
  );
  expect(result.request?.capabilityRevision).toBe('shell-revision');
  expect(result.request?.runOn).toBe('openshell');
});

it('refuses an older ambiguous route without choosing the first environment', () => {
  const data: ExplicitLocalInventory = localInventoryFixture();
  data.targets.push({ ...data.targets[0], location: 'openshell', label: 'OpenShell' });
  const route = normalizeLocalInventory(data).routes[0];
  expect(route.available).toBe(false);
  expect(route.reason).toContain('ambiguous');
});

it.each(['local', 'openshell'] as const)(
  'keeps reviewed Builder context separate from the user prompt on %s first commands',
  async (location) => {
    const { ordinaryRuntimeInventoryFixture } =
      await import('../../test-utils/ordinary-runtime-inventory-fixture');
    const data = ordinaryRuntimeInventoryFixture();
    const profile = {
      kind: 'builtin' as const,
      profileId: PROFILE_BUILDER_ID,
      revision: PROFILE_BUILDER_REVISION,
      definition: profileBuilderDefinition,
      contentHash: sha256Hex(JSON.stringify(profileBuilderDefinition)),
    };
    const inventory = ExplicitLocalInventorySchema.parse({ ...data, agentProfiles: [profile] });
    const selection = {
      ...createChatRuntimeSelection(),
      agentProfile: {
        kind: 'builtin' as const,
        profileId: PROFILE_BUILDER_ID,
        revision: PROFILE_BUILDER_REVISION,
      },
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
      execution: { location, targetId: location === 'local' ? 'mac' : 'sandbox' },
      capabilityRevision: inventory.capabilityRevision,
    };
    const content = JSON.stringify({
      version: 1,
      source: {
        kind: 'draft',
        profileId: 'bob',
        baseRevision: 3,
        draftVersion: null,
        expectedVersion: 2,
      },
      definition: {
        ...data.agentProfiles[0].definition,
        name: 'Working Bob',
        instructions: 'Exact\n whitespace ',
      },
    });
    const source = { kind: 'agent-library' as const, revision: sha256Hex(content), content };
    const input = {
      clientMsgId: 'reviewed-first',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      mode: 'agent' as const,
      text: 'Help refine',
      sourceSnapshots: [source],
    };
    const before = structuredClone(selection);
    const request = prepareLocalFirstCommand(selection, inventory, input).request!;
    expect(request.payload.text).toBe('Help refine');
    expect(request.payload.sourceSnapshots).toEqual([source]);
    expect(selection).toEqual(before);
    const { sourceSnapshots: _source, ...nextInput } = input;
    expect(_source).toEqual([source]);
    const next = prepareLocalContinuationCommand(selection, inventory, {
      ...nextInput,
      clientMsgId: 'follow-up',
      sessionId: 'assigned',
    }).request!;
    expect(next.payload.sourceSnapshots).toBeUndefined();
  },
);
