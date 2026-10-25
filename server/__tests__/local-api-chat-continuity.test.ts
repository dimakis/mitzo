import { afterEach, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import {
  OrdinaryLocalVertexTarget,
  ordinaryLocalVertexContractRevision,
  localVertexCapabilities,
} from '../ordinary-local-vertex-capabilities.js';
import {
  OrdinaryLocalResponsesTarget,
  ordinaryLocalResponsesContractRevision,
  localResponsesCapabilities,
} from '../ordinary-local-responses-capabilities.js';
import { AccountProfiles } from '../account-profiles.js';
const f = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  artifacts: { 'offline.ts': 'release-a' },
  host: 'original-host',
}));
vi.mock('node:os', async (original) => ({ ...(await original<object>()), hostname: () => f.host }));
vi.mock('../ordinary-local-codex-host-runtime.js', () => ({
  readPrivateRuntimeSettings: () => f.settings,
}));
vi.mock('../connections/reviewed-handler-artifacts.js', async (original) => ({
  ...(await original<object>()),
  reviewedHandlerSourceArtifacts: f.artifacts,
}));
afterEach(() => {
  f.artifacts['offline.ts'] = 'release-a';
  f.host = 'original-host';
});
const profiles = new AccountProfiles([
  {
    id: 'claude',
    label: 'Claude',
    provider: 'anthropic-vertex',
    projectId: 'project',
    region: 'region',
    credentialRef: '/offline/adc',
    models: [{ id: 'offline', label: 'Offline' }],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    provider: 'google-vertex',
    projectId: 'project',
    region: 'region',
    credentialRef: '/offline/adc',
    models: [{ id: 'offline', label: 'Offline' }],
  },
]);
function configured(engine: 'claude-sdk' | 'gemini', label = 'Host Mac') {
  f.settings = {
    version: 1,
    targetId: 'mac',
    label,
    hostId: hostname(),
    runtimeContractRevision:
      engine === 'gemini'
        ? ordinaryLocalResponsesContractRevision('gemini')
        : ordinaryLocalVertexContractRevision(),
  };
  return engine === 'gemini'
    ? new OrdinaryLocalResponsesTarget(
        { MITZO_ORDINARY_LOCAL_GEMINI_TARGET_FILE: '/offline/gemini-target.json' },
        'gemini',
      )
    : new OrdinaryLocalVertexTarget({
        MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE: '/offline/vertex-target.json',
      });
}
// Exact v1 declaration format and reviewed source closure of accepted 86916da4af1c.
function legacyRevision(engine: 'claude-sdk' | 'gemini', contract?: string) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        `ordinary-local-${engine === 'claude-sdk' ? 'vertex' : engine}-target-v1`,
        {
          version: 1,
          targetId: 'mac',
          label: 'Host Mac',
          hostId: hostname(),
          runtimeContractRevision:
            contract ??
            (engine === 'claude-sdk'
              ? 'ee64395c460a8366282b8cf92d7f28dcf22df2526efac2239192c91d0f74dd7c'
              : '4745665b0ee5eb29e5a4187f8205834149986054b4b6522dbaf2605b37d715e0'),
        },
      ]),
    )
    .digest('hex');
}
it.each(['claude-sdk', 'gemini'] as const)(
  'keeps %s conversation identity stable across code upgrades and label edits',
  (engine) => {
    const originalTarget = configured(engine);
    const original = originalTarget.descriptor();
    const initial =
      engine === 'gemini'
        ? localResponsesCapabilities(profiles, originalTarget as OrdinaryLocalResponsesTarget)
        : localVertexCapabilities(profiles, originalTarget as OrdinaryLocalVertexTarget);
    const request = {
      account: initial.inventory().accounts[0].account,
      harness: engine,
      targetId: 'mac',
      mode: 'agent',
    };
    const resolved = initial.resolve(request);
    if (resolved.status !== 'compatible') throw Error('fixture');
    f.artifacts['offline.ts'] = 'release-b';
    const upgraded = configured(engine);
    f.settings.label = 'Renamed Host';
    const renamed =
      engine === 'gemini'
        ? new OrdinaryLocalResponsesTarget(
            { MITZO_ORDINARY_LOCAL_GEMINI_TARGET_FILE: '/offline/gemini-target.json' },
            'gemini',
          )
        : new OrdinaryLocalVertexTarget({
            MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE: '/offline/vertex-target.json',
          });
    expect(upgraded.descriptor().targetRevision).toBe(original.targetRevision);
    expect(renamed.descriptor().targetRevision).toBe(original.targetRevision);
    const retained =
      engine === 'gemini'
        ? localResponsesCapabilities(
            profiles,
            renamed as OrdinaryLocalResponsesTarget,
            resolved.binding,
          )
        : localVertexCapabilities(
            profiles,
            renamed as OrdinaryLocalVertexTarget,
            [],
            resolved.binding,
          );
    expect(retained.resolve(request)).toEqual(resolved);
    expect(retained.declaration.targetRevision).toBe(original.targetRevision);
  },
);
it.each(['claude-sdk', 'gemini'] as const)(
  'retains original %s command receipts while qualifying current account/host configuration',
  (engine) => {
    const target = configured(engine);
    const provider = engine === 'gemini' ? 'google-vertex' : 'anthropic-vertex';
    const account = profiles.resolve(engine === 'gemini' ? 'gemini' : 'claude', 'offline');
    const binding = {
      version: 2 as const,
      account: { accountId: account.accountId, provider, profileRevision: account.profileRevision },
      harness: { implementation: engine },
      execution: {
        location: 'local' as const,
        targetId: 'mac',
        targetRevision: legacyRevision(engine),
      },
    };
    const catalog =
      engine === 'gemini'
        ? localResponsesCapabilities(profiles, target as OrdinaryLocalResponsesTarget, binding)
        : localVertexCapabilities(profiles, target as OrdinaryLocalVertexTarget, [], binding);
    const request = { account: binding.account, harness: engine, targetId: 'mac', mode: 'agent' };
    expect(catalog.resolve(request)).toEqual({ status: 'compatible', binding });
    expect(catalog.declaration.targetRevision).toBe(binding.execution.targetRevision);
    expect(
      catalog.resolve({ ...request, account: { ...binding.account, profileRevision: 'changed' } })
        .status,
    ).toBe('rejected');
  },
);

it.each(['claude-sdk', 'gemini'] as const)(
  'rejects %s host drift for both stable and reviewed legacy bindings',
  (engine) => {
    const target = configured(engine);
    const account = profiles.resolve(engine === 'gemini' ? 'gemini' : 'claude', 'offline');
    const binding = {
      version: 2 as const,
      account: {
        accountId: account.accountId,
        provider: account.provider,
        profileRevision: account.profileRevision,
      },
      harness: { implementation: engine },
      execution: {
        location: 'local' as const,
        targetId: 'mac',
        targetRevision: target.descriptor().targetRevision,
      },
    };
    const revisions = [
      binding.execution.targetRevision,
      legacyRevision(engine),
      'unknown-release',
      ...(engine === 'claude-sdk'
        ? [
            legacyRevision(
              engine,
              'd653db8d6727aee2a2ac983103d2166dfdfcc8d1da625e58f5d7b77fe8343a2f',
            ),
            legacyRevision(
              engine,
              'bb55cd5e91a9712c68a16886cecd4ffa3eeb44dbf5a0dc7909750be8a46a5e69',
            ),
          ]
        : []),
    ];
    f.host = 'different-host';
    const changed = configured(engine);
    for (const targetRevision of revisions) {
      const retained = { ...binding, execution: { ...binding.execution, targetRevision } };
      const catalog =
        engine === 'gemini'
          ? localResponsesCapabilities(profiles, changed as OrdinaryLocalResponsesTarget, retained)
          : localVertexCapabilities(profiles, changed as OrdinaryLocalVertexTarget, [], retained);
      expect(
        catalog.resolve({
          account: binding.account,
          harness: engine,
          targetId: 'mac',
          mode: 'agent',
        }).status,
      ).toBe('rejected');
      expect(() => catalog.declaration).toThrow();
    }
  },
);

it.each([
  ['c42ce72a2', 'd653db8d6727aee2a2ac983103d2166dfdfcc8d1da625e58f5d7b77fe8343a2f'],
  ['263cfea8b', 'bb55cd5e91a9712c68a16886cecd4ffa3eeb44dbf5a0dc7909750be8a46a5e69'],
])('qualifies the exact retained Claude host/protocol from accepted %s', (_commit, contract) => {
  const target = configured('claude-sdk');
  const initial = localVertexCapabilities(profiles, target as OrdinaryLocalVertexTarget);
  const request = {
    account: initial.inventory().accounts[0].account,
    harness: 'claude-sdk',
    targetId: 'mac',
    mode: 'agent',
  };
  const resolved = initial.resolve(request);
  if (resolved.status !== 'compatible') throw Error('fixture');
  const binding = {
    ...resolved.binding,
    execution: {
      ...resolved.binding.execution,
      targetRevision: legacyRevision('claude-sdk', contract),
    },
  };
  const catalog = localVertexCapabilities(
    profiles,
    target as OrdinaryLocalVertexTarget,
    [],
    binding,
  );
  expect(catalog.resolve(request)).toEqual({ status: 'compatible', binding });
  expect(catalog.declaration.targetRevision).toBe(binding.execution.targetRevision);
});

it.each(['claude-sdk', 'gemini'] as const)(
  'rejects an unreviewed %s deployment or protocol revision on the same host',
  (engine) => {
    const target = configured(engine);
    const initial =
      engine === 'gemini'
        ? localResponsesCapabilities(profiles, target as OrdinaryLocalResponsesTarget)
        : localVertexCapabilities(profiles, target as OrdinaryLocalVertexTarget);
    const account = initial.inventory().accounts[0].account;
    const request = { account, harness: engine, targetId: 'mac', mode: 'agent' };
    const resolved = initial.resolve(request);
    if (resolved.status !== 'compatible') throw Error('fixture');
    const unsupportedProtocol = createHash('sha256')
      .update(
        JSON.stringify([
          `ordinary-local-${engine === 'claude-sdk' ? 'vertex' : engine}-target-v2`,
          'mac',
          hostname(),
          `${engine}-session-v2`,
        ]),
      )
      .digest('hex');
    for (const revision of ['unreviewed-release', unsupportedProtocol]) {
      const retained = {
        ...resolved.binding,
        execution: { ...resolved.binding.execution, targetRevision: revision },
      };
      const catalog =
        engine === 'gemini'
          ? localResponsesCapabilities(profiles, target as OrdinaryLocalResponsesTarget, retained)
          : localVertexCapabilities(profiles, target as OrdinaryLocalVertexTarget, [], retained);
      expect(catalog.resolve(request).status).toBe('rejected');
      expect(() => catalog.declaration).toThrow();
    }
  },
);

it.each(['claude-sdk', 'gemini'] as const)(
  'keeps unprovable original %s legacy labels blocked',
  (engine) => {
    const original = configured(engine);
    const initial =
      engine === 'gemini'
        ? localResponsesCapabilities(profiles, original as OrdinaryLocalResponsesTarget)
        : localVertexCapabilities(profiles, original as OrdinaryLocalVertexTarget);
    const request = {
      account: initial.inventory().accounts[0].account,
      harness: engine,
      targetId: 'mac',
      mode: 'agent',
    };
    const resolved = initial.resolve(request);
    if (resolved.status !== 'compatible') throw Error('fixture');
    const binding = {
      ...resolved.binding,
      execution: { ...resolved.binding.execution, targetRevision: legacyRevision(engine) },
    };
    const renamed = configured(engine, 'Renamed Host');
    const catalog =
      engine === 'gemini'
        ? localResponsesCapabilities(profiles, renamed as OrdinaryLocalResponsesTarget, binding)
        : localVertexCapabilities(profiles, renamed as OrdinaryLocalVertexTarget, [], binding);
    expect(catalog.resolve(request).status).toBe('rejected');
    expect(() => catalog.declaration).toThrow();
  },
);
