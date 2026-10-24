import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { ownedResponsesRuntimeFixture } from './fixtures/owned-local-responses-runtime.js';
import { OrdinaryLocalResponsesOwnedRuntime } from '../ordinary-local-responses-owned-runtime.js';
import { NativeResponsesStore } from '../native-responses-store.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('refuses the old OpenAI owner before keys, workspace acquisition or legacy history changes', async () => {
  const f = await ownedResponsesRuntimeFixture(cleanups);
  const native = new NativeResponsesStore(join(f.root, 'responses.db'));
  cleanups.push(() => native.close());
  const state = {
    status: 'interrupted' as const,
    history: [{ role: 'user' as const, content: 'Retained original work' }],
  };
  native.save(f.reservation.conversationId, f.reservation.binding, state);
  const dirty = join(f.root, 'source', 'dirty-retained.txt');
  await writeFile(dirty, 'Preserve this edit');
  const claim = vi.spyOn(f.workspace, 'claimReservedHostTask');
  const dispatch = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(
    () =>
      new OrdinaryLocalResponsesOwnedRuntime({
        enabled: true,
        eventStore: f.events,
        library: f.library,
        workspace: f.workspace,
        reservation: f.reservation,
        nativeStore: native,
        commandId: f.request.clientMsgId,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        signal: f.signal.signal,
        env: f.dependencies.env,
        dispatch,
      }),
  ).toThrow('retired');
  expect(claim).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(native.load(f.reservation.conversationId, f.reservation.binding)).toEqual(state);
  expect(await readFile(dirty, 'utf8')).toBe('Preserve this edit');
});
