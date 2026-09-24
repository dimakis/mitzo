import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_SEARCH_MODE_CEILINGS,
  initialWebSearchGrant,
  resolveWebSearchPolicy,
  type WebSearchGrant,
} from '../web-search-policy.js';

const resolve = (
  mode: 'ask' | 'agent' | 'auto',
  grant: WebSearchGrant,
  deploymentCeiling: 'disabled' | 'live' = 'live',
) =>
  resolveWebSearchPolicy({
    backend: 'host',
    deploymentCeiling,
    deploymentRevision: 'deployment-7',
    mode,
    conversationGrant: { grant, revision: 3, updatedAt: 123 },
  });

describe('server-owned web-search policy', () => {
  it.each([
    ['ask', 'unresolved', 'mode_ceiling'],
    ['ask', 'denied', 'mode_ceiling'],
    ['ask', 'allowed', 'mode_ceiling'],
    ['agent', 'unresolved', 'grant_unresolved'],
    ['agent', 'denied', 'grant_denied'],
    ['agent', 'allowed', 'allowed'],
    ['auto', 'unresolved', 'grant_unresolved'],
    ['auto', 'denied', 'grant_denied'],
    ['auto', 'allowed', 'allowed'],
  ] as const)('resolves %s with %s fail-closed', (mode, grant, reason) => {
    const result = resolve(mode, grant);
    expect(result.reason).toBe(reason);
    expect(result.effective).toBe(reason === 'allowed' ? 'live' : 'disabled');
  });

  it('lets the deployment ceiling override every mode and grant', () => {
    for (const mode of ['ask', 'agent', 'auto'] as const) {
      expect(resolve(mode, 'allowed', 'disabled')).toMatchObject({
        effective: 'disabled',
        reason: 'deployment_ceiling',
      });
    }
  });

  it('allows operator-configured mode ceilings only to narrow authority', () => {
    expect(
      resolveWebSearchPolicy({
        backend: 'openshell',
        deploymentCeiling: 'live',
        deploymentRevision: 'deployment-7',
        mode: 'auto',
        modeCeilings: { ...DEFAULT_WEB_SEARCH_MODE_CEILINGS, auto: 'disabled' },
        conversationGrant: { grant: 'allowed', revision: 1, updatedAt: 123 },
      }),
    ).toMatchObject({ effective: 'disabled', reason: 'mode_ceiling' });
    expect(
      resolveWebSearchPolicy({
        backend: 'host',
        deploymentCeiling: 'live',
        deploymentRevision: 'deployment-7',
        mode: 'ask',
        modeCeilings: { ask: 'live', agent: 'live', auto: 'live' },
        conversationGrant: { grant: 'allowed', revision: 1, updatedAt: 123 },
      }),
    ).toMatchObject({ effective: 'disabled', reason: 'mode_ceiling' });
  });

  it('requires explicit consent for every new conversation mode', () => {
    expect(initialWebSearchGrant('ask')).toBe('unresolved');
    expect(initialWebSearchGrant('agent')).toBe('unresolved');
    expect(initialWebSearchGrant('auto')).toBe('unresolved');
  });

  it('binds deployment, mode, backend, and grant revisions into the fingerprint', () => {
    const baseline = resolve('agent', 'allowed');
    expect(baseline.fingerprint).toHaveLength(64);
    expect(resolve('agent', 'allowed').fingerprint).toBe(baseline.fingerprint);
    expect(resolve('auto', 'allowed').fingerprint).not.toBe(baseline.fingerprint);
    expect(
      resolveWebSearchPolicy({
        backend: 'openshell',
        deploymentCeiling: 'live',
        deploymentRevision: 'deployment-7',
        mode: 'agent',
        conversationGrant: { grant: 'allowed', revision: 3, updatedAt: 123 },
      }).fingerprint,
    ).not.toBe(baseline.fingerprint);
  });
});
