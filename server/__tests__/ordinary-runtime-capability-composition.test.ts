import { expect, it } from 'vitest';
import { composeOrdinaryRuntimeCapabilities } from '../ordinary-runtime-capability-composition.js';
const account = {
  accountId: 'enrolled-api',
  provider: 'openai' as const,
  profileRevision: 'one-credential-routing-revision',
};
const source = (harness: 'codex' | 'responses', model: string, stale = false) => ({
  capabilityRevision: `snapshot-${harness}`,
  accounts: [
    {
      account,
      label: 'Work API',
      models: [{ id: model, label: model, reasoningEfforts: ['high'] }],
      modelDiscovery: { source: 'configured' as const, stale },
    },
  ],
  routes: [
    {
      account,
      targetId: harness === 'codex' ? 'shell' : 'mac',
      harness,
      modes: ['agent'] as const,
    },
  ],
});
it('keeps one opaque enrolled account while preserving each environment software and catalog snapshots', () => {
  const merged = composeOrdinaryRuntimeCapabilities([
    source('codex', 'shell-model'),
    source('responses', 'local-model'),
  ]);
  expect(merged.accounts).toHaveLength(1);
  expect(merged.accounts[0].account).toEqual(account);
  expect(
    merged.routes.map((route) => [
      route.account,
      route.targetId,
      route.harness,
      route.models[0].id,
      route.capabilityRevision,
    ]),
  ).toEqual([
    [account, 'shell', 'codex', 'shell-model', 'snapshot-codex'],
    [account, 'mac', 'responses', 'local-model', 'snapshot-responses'],
  ]);
});
it('does not let one unavailable target hide the available account route or switch opaque identity', () => {
  const merged = composeOrdinaryRuntimeCapabilities([
    source('codex', 'shell-model', true),
    source('responses', 'local-model'),
  ]);
  expect(merged.routes[0].modelDiscovery.stale).toBe(true);
  expect(merged.routes[1].modelDiscovery.stale).toBe(false);
  const drift = source('responses', 'local-model');
  drift.accounts[0].account = { ...account, profileRevision: 'other-credential' };
  expect(() => composeOrdinaryRuntimeCapabilities([source('codex', 'shell-model'), drift])).toThrow(
    'identity',
  );
});
