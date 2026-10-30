import { expect, it } from 'vitest';
import {
  TurnCallbacks,
  retainCallbackOutcome,
  callbackOutcome,
  assertTurnCallbackEffects,
} from '../turn-callbacks.js';
it('does not accept cloned or structural data as original effect evidence', () => {
  const result = retainCallbackOutcome(
    { isError: true, content: 'denied before execution' },
    'settled',
  );
  expect(callbackOutcome(result)).toBe('settled');
  expect(callbackOutcome({ ...result, effectStatus: 'not_started' })).toBe('unknown');
  expect(callbackOutcome(JSON.parse(JSON.stringify(result)))).toBe('unknown');
});
it('expires effect authority while retaining only original callback settlement', async () => {
  const callbacks = new TurnCallbacks();
  let finish!: () => void;
  const work = callbacks.track(async () => {
    assertTurnCallbackEffects();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assertTurnCallbackEffects();
  });
  const blockedWork = expect(work).rejects.toMatchObject({ code: 'turn_completed' });
  const blockedSettlement = expect(
    callbacks.settle(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'callbacks_failed' });
  finish();
  await blockedWork;
  await blockedSettlement;
});

it('registers and starts a callback synchronously before a following terminal notification', async () => {
  const callbacks = new TurnCallbacks();
  let started = false;
  const work = callbacks.track(async () => {
    started = true;
  });
  callbacks.seal();
  expect(started).toBe(true);
  await work;
});
it.each(['reject', 'error result'])(
  'retains an unknown %s outcome rather than releasing terminal work',
  async (kind) => {
    const callbacks = new TurnCallbacks();
    let finish!: () => void;
    const work = callbacks.track(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (kind === 'reject') throw Error('private failure after effects');
      return { isError: true, content: 'Unknown external result' };
    });
    const observed = work.catch(() => {});
    await Promise.resolve();
    const settling = callbacks.settle(new AbortController().signal);
    const blocked = expect(settling).rejects.toMatchObject({ code: 'callbacks_failed' });
    finish();
    await observed;
    await blocked;
  },
);
