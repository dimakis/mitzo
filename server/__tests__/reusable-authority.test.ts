import { describe, expect, it } from 'vitest';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { SessionCapabilityGrants, captureSessionCapability } from '../session-capability-grants.js';

describe('reusable authority scopes', () => {
  it('inherits repository development only through trusted custody, account and login', async () => {
    const f = capabilityFixture();
    const identities = new Map([
      ['one', 'repo-a'],
      ['two', 'repo-a'],
      ['foreign', 'repo-a'],
    ]);
    const grants = new SessionCapabilityGrants(f.registry, (s) => identities.get(s.sessionId!));
    const grant = grants.create('operator', {
      sessionIds: ['one'],
      scope: 'repository',
      capability: { kind: 'development' },
      durationMinutes: 60,
    });
    const two = f.registry.get('two')!;
    const receipt = captureSessionCapability(two, { kind: 'development' });
    expect(receipt).toBeTypeOf('function');
    expect(receipt).not.toThrow();
    expect(grants.list('operator', 'two')[0]).toMatchObject({ id: grant.id, scope: 'repository' });
    expect(grants.capture(f.registry.get('foreign')!, { kind: 'development' })).toBeUndefined();
    identities.set('two', 'repo-b');
    expect(receipt).toThrow();
    expect(grants.capture(two, { kind: 'development' })).toBeUndefined();
    identities.set('two', 'repo-a');
    two.accountBinding!.accountId = 'different';
    expect(grants.capture(two, { kind: 'development' })).toBeUndefined();
    await grants.revoke('operator', 'one', grant.id);
  });

  it('shares exact source and outcome grants across chats without changing other tools', async () => {
    const { registry, grants, session } = capabilityFixture();
    const google = {
      kind: 'google-read',
      email: 'me@example.test',
      resource: { kind: 'file', id: 'doc-a' },
    } as const;
    const grant = grants.create('operator', {
      sessionIds: ['one'],
      scope: 'operator',
      capability: google,
      durationMinutes: 60,
    });
    const two = registry.get('two')!;
    const receipt = captureSessionCapability(two, google)!;
    expect(receipt).toBeTypeOf('function');
    expect(grants.capture(two, { ...google, email: 'other@example.test' })).toBeUndefined();
    expect(
      grants.capture(two, { ...google, resource: { kind: 'file', id: 'doc-b' } }),
    ).toBeUndefined();
    expect(grants.capture(two, { kind: 'development' })).toBeUndefined();
    await grants.revoke('operator', 'two', grant.id);
    expect(receipt).toThrow();
    grants.create('operator', {
      sessionIds: ['one'],
      scope: 'operator',
      capability: { kind: 'telos-progress', itemId: 'outcome' },
      durationMinutes: 60,
    });
    expect(captureSessionCapability(two, { kind: 'telos-progress', itemId: 'outcome' })).toBeTypeOf(
      'function',
    );
    expect(
      grants.capture(session, { kind: 'telos-progress', itemId: 'unrelated' }),
    ).toBeUndefined();
    expect(() =>
      grants.create('operator', {
        sessionIds: ['one'],
        scope: 'operator',
        capability: { kind: 'development' },
        durationMinutes: 60,
      }),
    ).toThrow();
    expect(() =>
      grants.create('operator', {
        sessionIds: ['one'],
        scope: 'repository',
        capability: { kind: 'public-web' },
        durationMinutes: 60,
      }),
    ).toThrow();
  });

  it('binds inherited receipts to the first runtime and workspace observation', () => {
    const { registry, grants } = capabilityFixture();
    grants.create('operator', {
      sessionIds: ['one'],
      scope: 'operator',
      capability: { kind: 'github-read', repository: 'org/repo' },
      durationMinutes: 60,
    });
    const two = registry.get('two')!;
    const current = grants.capture(two, { kind: 'github-read', repository: 'org/repo' })!;
    expect(current).toBeTypeOf('function');
    two.mode = 'ask';
    expect(current).toThrow();
    expect(grants.capture(two, { kind: 'github-read', repository: 'org/repo' })).toBeUndefined();
    two.mode = 'agent';
    const next = grants.capture(two, { kind: 'github-read', repository: 'org/repo' })!;
    expect(next).toBeTypeOf('function');
    two.cwd = '/replaced';
    expect(next).toThrow();
    expect(current).toThrow();
  });
});
