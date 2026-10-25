import { afterEach, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
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
}));
vi.mock('../ordinary-local-codex-host-runtime.js', () => ({
  readPrivateRuntimeSettings: () => f.settings,
}));
vi.mock('../connections/reviewed-handler-artifacts.js', async (original) => ({
  ...(await original<object>()),
  reviewedHandlerSourceArtifacts: f.artifacts,
}));
afterEach(() => {
  f.artifacts['offline.ts'] = 'release-a';
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
function configured(engine: 'claude-sdk' | 'gemini') {
  f.settings = {
    version: 1,
    targetId: 'mac',
    label: 'Host Mac',
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
it.each(['claude-sdk', 'gemini'] as const)(
  'keeps %s conversation identity stable across code upgrades and label edits',
  (engine) => {
    const original = configured(engine).descriptor();
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
        targetRevision: 'original-deployment',
      },
    };
    const catalog =
      engine === 'gemini'
        ? localResponsesCapabilities(profiles, target as OrdinaryLocalResponsesTarget, binding)
        : localVertexCapabilities(profiles, target as OrdinaryLocalVertexTarget, [], binding);
    const request = { account: binding.account, harness: engine, targetId: 'mac', mode: 'agent' };
    expect(catalog.resolve(request)).toEqual({ status: 'compatible', binding });
    expect(catalog.declaration.targetRevision).toBe('original-deployment');
    expect(
      catalog.resolve({ ...request, account: { ...binding.account, profileRevision: 'changed' } })
        .status,
    ).toBe('rejected');
  },
);
