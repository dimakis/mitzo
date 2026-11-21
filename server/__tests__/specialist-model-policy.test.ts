import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistModelPolicyStore } from '../specialist-model-policy-store.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const rules = (admission: 'ask' | 'auto' | 'off', allowance: number | null = null) => ({
  models: [{ accountId: 'personal', model: 'chosen-model', admission, allowance }],
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'model-policy-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.db');
  const store = new SpecialistModelPolicyStore(path);
  cleanup.push(() => store.close());
  return { store, path };
}
it('persists workspace defaults, isolates overrides and restores inheritance', () => {
  const { store, path } = fixture();
  expect(store.resolve('chat', 'personal', 'chosen-model').admission).toBe('ask');
  store.save('workspace', {
    requestId: randomUUID(),
    expectedRevision: 0,
    policy: rules('auto', 3),
  });
  expect(store.resolve('chat', 'personal', 'chosen-model')).toMatchObject({
    admission: 'auto',
    allowance: 3,
  });
  store.save('chat', { requestId: randomUUID(), expectedRevision: 0, policy: rules('off') });
  expect(store.resolve('chat', 'personal', 'chosen-model').admission).toBe('off');
  expect(store.resolve('other', 'personal', 'chosen-model').admission).toBe('auto');
  const reopened = new SpecialistModelPolicyStore(path);
  expect(reopened.resolve('chat', 'personal', 'chosen-model').admission).toBe('off');
  reopened.close();
  store.save('chat', { requestId: randomUUID(), expectedRevision: 1, policy: null });
  expect(store.resolve('chat', 'personal', 'chosen-model').admission).toBe('auto');
  expect(store.resolve('chat', 'another-account', 'chosen-model').admission).toBe('ask');
});
it('retains exact save receipts and refuses stale edits or conflicting retries', () => {
  const { store } = fixture();
  const input = { requestId: randomUUID(), expectedRevision: 0, policy: rules('auto') };
  const first = store.save('chat', input);
  expect(store.save('chat', input)).toEqual(first);
  expect(() => store.save('chat', { ...input, policy: rules('off') })).toThrow(/request conflict/);
  expect(() => store.save('chat', { ...input, requestId: randomUUID() })).toThrow(
    /revision conflict/,
  );
  expect(() =>
    store.save('chat', {
      requestId: randomUUID(),
      expectedRevision: 1,
      policy: {
        models: [...rules('ask').models, ...rules('off').models],
      },
    }),
  ).toThrow();
});
