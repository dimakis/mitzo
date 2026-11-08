import { expect, it } from 'vitest';
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
