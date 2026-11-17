import { expect, it, vi } from 'vitest';
import { buildPermissionHandler, resolvePending } from '@mitzo/harness';
import { decideTelosApproval } from '../telos-approval-policy.js';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { captureTelosProgressConsent } from '../telos-progress-consent.js';
it('permits evidence and status updates only for the approved item, without granting general edits', async () => {
  const f = capabilityFixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'telos-progress', itemId: 'item' },
    durationMinutes: 60,
  });
  const input = {
    itemId: 'item',
    requestId: 'r',
    expectedRevision: 'a'.repeat(64),
    note: 'Verified evidence',
    status: 'completed',
  };
  const consent = captureTelosProgressConsent(f.session, 'TelosUpdateItem', input)!;
  expect(consent).toBeTypeOf('function');
  expect(consent).not.toThrow();
  for (const [name, exact] of [
    ['TelosManageItem', { operation: 'edit', itemId: 'item', summary: 'Changed scope' }],
    ['TelosUpdateItem', { ...input, itemId: 'other' }],
    ['TelosUpdateItem', { ...input, summary: 'Changed scope' }],
  ] as const)
    expect(captureTelosProgressConsent(f.session, name, exact)).toBeUndefined();
  await f.grants.revoke('operator', 'one', grant.id);
  expect(consent).toThrow();
});

it.each(['agent', 'auto'] as const)(
  'shares one Telos approval policy across adapters in %s mode',
  async (mode) => {
    const f = capabilityFixture();
    f.session.mode = mode;
    const decide = (name: string, input: Record<string, unknown>, consent = {}) =>
      decideTelosApproval(
        f.session,
        name,
        input,
        (scope) =>
          buildPermissionHandler('one', f.registry)(name, input, {
            signal: AbortSignal.timeout(5_000),
            toolUseID: `${name}:${JSON.stringify(input)}`,
            forcePrompt: true,
            allowSessionGrant: false,
            approvalScope: 'request',
            ...scope,
          }),
        consent,
      );
    const cards = () => f.sent.filter((event) => event.type === 'permission_request');
    const answerNext = (decision: 'once' | 'always') =>
      queueMicrotask(() => resolvePending(String(cards().at(-1)!.permId), decision));
    // Reviewed reads (both wire spellings and a mixed tool's read) never card.
    for (const [name, input] of [
      ['TelosGetItem', { itemId: 'item' }],
      ['mcp__telos__TelosReadArtifact', { id: 'a'.repeat(32), revision: 1 }],
      ['mcp__telos__TelosFindArtifacts', { itemId: 'item' }],
    ] as const)
      expect(await decide(name, input)).toMatchObject({ behavior: 'allow' });
    expect(cards()).toHaveLength(0);
    // Edits, lifecycle and consults keep the exact card.
    for (const [name, input] of [
      ['TelosManageItem', { operation: 'edit', itemId: 'item' }],
      ['TelosManageItem', { operation: 'archive', itemId: 'item' }],
      ['SymposiumConsult', { operation: 'consult' }],
    ] as const) {
      const pending = decide(name, input);
      await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
      answerNext('once');
      expect(await pending).toMatchObject({ behavior: 'allow' });
      f.sent.splice(0);
    }
    // An item-scoped save key is reused only for that exact key.
    const save = { key: 'telos-save:item-assignment', assertCurrent: () => {} };
    const first = decide('TelosSaveArtifact', { itemId: 'item' }, { save });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toMatchObject({ approvalScope: 'session' });
    answerNext('always');
    expect(await first).toMatchObject({ behavior: 'allow' });
    expect(await decide('TelosSaveArtifact', { itemId: 'item' }, { save })).toMatchObject({
      behavior: 'allow',
    });
    expect(cards()).toHaveLength(1);
    const other = decide(
      'TelosSaveArtifact',
      { itemId: 'other' },
      { save: { ...save, key: 'telos-save:other-assignment' } },
    );
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    answerNext('once');
    await other;
    expect(f.session.sessionAllowList.has('TelosSaveArtifact')).toBe(false);
  },
);

it('keeps the Ask card for Telos reads and denies Ask mutations before any grant', async () => {
  const f = capabilityFixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: { kind: 'telos-progress', itemId: 'item' },
    durationMinutes: 60,
  });
  const update = {
    itemId: 'item',
    requestId: 'r',
    expectedRevision: 'a'.repeat(64),
    note: 'Verified evidence',
  };
  const progress = captureTelosProgressConsent(f.session, 'TelosUpdateItem', update)!;
  const decide = (name: string, input: Record<string, unknown>) =>
    decideTelosApproval(
      f.session,
      name,
      input,
      (scope) =>
        buildPermissionHandler('one', f.registry)(name, input, {
          signal: AbortSignal.timeout(5_000),
          toolUseID: name,
          forcePrompt: true,
          allowSessionGrant: false,
          approvalScope: 'request',
          ...scope,
        }),
      // Adapters capture progress consent for TelosUpdateItem only.
      name === 'TelosUpdateItem' ? { progress } : {},
    );
  expect(await decide('TelosUpdateItem', update)).toMatchObject({ behavior: 'allow' });
  f.session.mode = 'ask';
  expect(await decide('TelosUpdateItem', update)).toMatchObject({ behavior: 'deny' });
  const read = decide('TelosGetItem', { itemId: 'item' });
  await vi.waitFor(() =>
    expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1),
  );
  resolvePending(String(f.sent.at(-1)!.permId), 'deny');
  expect(await read).toMatchObject({ behavior: 'deny' });
  await f.grants.revoke('operator', 'one', grant.id);
});
