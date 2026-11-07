import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { SessionCapabilityGrants } from '../session-capability-grants.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registries: SessionRegistry[] = [];
const directories: string[] = [];
afterEach(() => {
  registries.splice(0).forEach((r) => r.dispose());
  directories.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
  vi.useRealTimers();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-capability-')));
  directories.push(root);
  const registry = new SessionRegistry();
  registries.push(registry);
  for (const id of ['one', 'two', 'foreign']) {
    mkdirSync(join(root, id));
    registry.register(id, {
      sessionId: id,
      mode: 'agent',
      cwd: join(root, id),
      ownedLocalAuthSessionId: id === 'foreign' ? 'other' : 'operator',
      accountBinding: {
        accountId: 'account',
        provider: 'openai-codex',
        profileRevision: 'v1',
        model: 'model',
      },
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      transport: { send() {}, isOpen: () => true },
    });
  }
  return {
    registry,
    grants: new SessionCapabilityGrants(registry),
    one: registry.get('one')!,
    two: registry.get('two')!,
  };
}
describe('operator-selected capability grants', () => {
  it('binds remote read grants to their runtime without admitting remote development access', () => {
    const { grants, one } = fixture();
    one.cwd = '/remote/workspace';
    one.ordinaryRuntimeOwner = {
      location: 'openshell',
      authSessionId: 'operator',
      identity: {},
    } as never;
    grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'public-web' },
      durationMinutes: 60,
    });
    const current = grants.capture(one, { kind: 'public-web' })!;
    expect(current).not.toThrow();
    expect(() =>
      grants.create('operator', {
        sessionIds: ['one'],
        capability: { kind: 'development' },
        durationMinutes: 60,
      }),
    ).toThrow('Local Codex');
    one.ordinaryRuntimeOwner!.identity = {};
    expect(current).toThrow();
  });
  it('refuses a reviewed selection after account or workspace context changes', () => {
    const { grants, one } = fixture();
    const revision = grants.selectionRevision('operator', 'one');
    one.accountBinding!.accountId = 'changed';
    expect(() =>
      grants.create('operator', {
        sessionIds: ['one'],
        capability: { kind: 'public-web' },
        durationMinutes: 60,
        expectedContexts: { one: revision },
      }),
    ).toThrow('context changed');
    expect(grants.list('operator', 'one')).toEqual([]);
  });
  it('never grants additional filesystem roots and invalidates recreated workspaces', () => {
    const { grants, one } = fixture();
    expect(() =>
      grants.create('operator', {
        sessionIds: ['one'],
        capability: { kind: 'development', writeRoots: ['/'] },
        durationMinutes: 60,
      }),
    ).toThrow();
    grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'public-web' },
      durationMinutes: 60,
    });
    const receipt = grants.capture(one, { kind: 'public-web' })!;
    rmSync(one.cwd!, { recursive: true });
    mkdirSync(one.cwd!);
    expect(receipt).toThrow();
    expect(grants.capture(one, { kind: 'public-web' })).toBeUndefined();
  });
  it('expires development access and interrupts its unchanged live owner', async () => {
    vi.useFakeTimers();
    const { grants, one } = fixture();
    const interrupt = vi.fn();
    one.queryInstance = { interrupt } as never;
    grants.create('operator', {
      sessionIds: ['one'],
      capability: { kind: 'development' },
      durationMinutes: 1,
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(grants.capture(one, { kind: 'development' })).toBeUndefined();
  });
  it('shares one expiring read grant only with explicitly selected sessions', () => {
    const { grants, one, two } = fixture();
    const grant = grants.create('operator', {
      sessionIds: ['one', 'two'],
      capability: { kind: 'github-read', repository: 'example/repo' },
      durationMinutes: 60,
    });
    expect(grants.capture(one, { kind: 'github-read', repository: 'example/repo' })).toBeTypeOf(
      'function',
    );
    expect(
      grants.capture(two, { kind: 'github-read', repository: 'example/other' }),
    ).toBeUndefined();
    const receipt = grants.capture(two, { kind: 'github-read', repository: 'example/repo' })!;
    expect(grants.list('operator', 'one')[0]).toMatchObject({
      id: grant.id,
      sessionIds: ['one', 'two'],
    });
    grants.revoke('operator', 'one', grant.id);
    expect(() => receipt()).toThrow();
    expect(
      grants.capture(one, { kind: 'github-read', repository: 'example/repo' }),
    ).toBeUndefined();
  });
  it('rejects foreign sessions atomically and never converts model inputs to grants', () => {
    const { grants, one } = fixture();
    expect(() =>
      grants.create('operator', {
        sessionIds: ['one', 'foreign'],
        capability: { kind: 'public-web' },
        durationMinutes: 60,
      }),
    ).toThrow();
    expect(grants.list('operator', 'one')).toEqual([]);
    for (const invalid of [
      { kind: 'github-read', repository: '*' },
      { kind: 'shell' },
      { kind: 'public-web', writes: true },
    ])
      expect(() =>
        grants.create('operator', {
          sessionIds: ['one'],
          capability: invalid,
          durationMinutes: 60,
        }),
      ).toThrow();
    expect(grants.capture(one, { kind: 'public-web' })).toBeUndefined();
  });
  it('invalidates captured permission after expiry, account change, Ask downgrade and workspace change', () => {
    for (const change of ['expiry', 'account', 'ask', 'workspace', 'abort'] as const) {
      const { grants, one } = fixture();
      vi.useFakeTimers();
      grants.create('operator', {
        sessionIds: ['one'],
        capability: { kind: 'development' },
        durationMinutes: 1,
      });
      const receipt = grants.capture(one, { kind: 'development' })!;
      expect(receipt).toBeTypeOf('function');
      if (change === 'expiry') vi.advanceTimersByTime(60_001);
      if (change === 'account') one.accountBinding!.profileRevision = 'v2';
      if (change === 'ask') one.mode = 'ask';
      if (change === 'workspace') one.cwd = '/another';
      if (change === 'abort') one.abortController.abort();
      expect(() => receipt()).toThrow();
      expect(grants.capture(one, { kind: 'development' })).toBeUndefined();
      vi.useRealTimers();
    }
  });
  it('does not revive old receipts after revoke and regrant, or share with replacement owners', () => {
    const { registry, grants, one } = fixture();
    const input = { sessionIds: ['one'], capability: { kind: 'public-web' }, durationMinutes: 60 };
    const first = grants.create('operator', input);
    const receipt = grants.capture(one, { kind: 'public-web' })!;
    grants.revoke('operator', 'one', first.id);
    grants.create('operator', input);
    expect(() => receipt()).toThrow();
    registry.get('one')!.ownedLocalAuthSessionId = 'other';
    expect(grants.capture(one, { kind: 'public-web' })).toBeUndefined();
  });
});
