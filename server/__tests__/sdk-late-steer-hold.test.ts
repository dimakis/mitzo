import { expect, it } from 'vitest';
import { AsyncQueue } from '../async-queue.js';
import { holdResultForLateSteer, type LateSteerLabel } from '../sdk-late-steer-hold.js';

type Event = Record<string, unknown>;

function harness(timeoutMs = 1_000) {
  const source = new AsyncQueue<Event>();
  const controller = new AbortController();
  let pendingSteer: LateSteerLabel | undefined;
  let awaitingEcho = false;
  const stream = holdResultForLateSteer(source, {
    hold: () => {
      const label = pendingSteer;
      pendingSteer = undefined;
      if (label) awaitingEcho = true;
      return label;
    },
    awaiting: () => awaitingEcho,
    signal: controller.signal,
    sessionId: 'session',
    timeoutMs,
  });
  const received: Event[] = [];
  const consumed = (async () => {
    for await (const event of stream) {
      received.push(event);
      // The real consumer acknowledges the echo while handling the event.
      if (event.type === 'user' && event.uuid === 'steer') awaitingEcho = false;
    }
  })();
  return {
    source,
    controller,
    received,
    consumed,
    steer: () => (pendingSteer = { kind: 'correction', id: 'request' }),
  };
}

it('passes results through when no steer is outstanding', async () => {
  const h = harness();
  h.source.push({ type: 'assistant' });
  h.source.push({ type: 'result', uuid: 'r1' });
  h.source.close();
  await h.consumed;
  expect(h.received.map((e) => e.type)).toEqual(['assistant', 'result']);
});

it('drops the held result once the follow-up turn echoes the steer, ending on its own result', async () => {
  const h = harness();
  h.steer();
  h.source.push({ type: 'result', uuid: 'first' });
  h.source.push({ type: 'system', subtype: 'init' });
  h.source.push({ type: 'user', uuid: 'steer' });
  h.source.push({ type: 'assistant' });
  h.source.push({ type: 'result', uuid: 'final' });
  h.source.close();
  await h.consumed;
  expect(h.received.map((e) => e.uuid ?? e.type)).toEqual([
    'system',
    'steer',
    'assistant',
    'final',
  ]);
});

it('releases the held result unchanged when no follow-up turn starts in time', async () => {
  const h = harness(20);
  h.steer();
  h.source.push({ type: 'result', uuid: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(h.received.map((e) => e.uuid)).toEqual(['first']);
  // Events still drain in order after release; nothing is lost or re-ordered.
  h.source.push({ type: 'system', subtype: 'late' });
  h.source.close();
  await h.consumed;
  expect(h.received.map((e) => e.uuid ?? e.subtype)).toEqual(['first', 'late']);
});

it('treats a further result without the echo as terminal, dropping the superseded one', async () => {
  const h = harness();
  h.steer();
  h.source.push({ type: 'result', uuid: 'first' });
  h.source.push({ type: 'assistant' });
  h.source.push({ type: 'result', uuid: 'second' });
  h.source.close();
  await h.consumed;
  expect(h.received.map((e) => e.uuid ?? e.type)).toEqual(['assistant', 'second']);
});

it('releases a held result when the stream ends', async () => {
  const h = harness();
  h.steer();
  h.source.push({ type: 'result', uuid: 'first' });
  h.source.close();
  await h.consumed;
  expect(h.received.map((e) => e.uuid)).toEqual(['first']);
});

it('releases a held result before propagating a source failure', async () => {
  const source = new AsyncQueue<Event>();
  const failure = Error('native iterator close failed');
  let steer: LateSteerLabel | undefined = { kind: 'peer', id: 'message' };
  const stream = holdResultForLateSteer(
    (async function* () {
      yield* source;
      throw failure;
    })(),
    {
      hold: () => {
        const label = steer;
        steer = undefined;
        return label;
      },
      awaiting: () => true,
      signal: new AbortController().signal,
      sessionId: 'session',
      timeoutMs: 10_000,
    },
  );
  const received: Event[] = [];
  const consumed = (async () => {
    for await (const event of stream) received.push(event);
  })();
  source.push({ type: 'result', uuid: 'first' });
  source.close();
  await expect(consumed).rejects.toBe(failure);
  expect(received.map((e) => e.uuid)).toEqual(['first']);
});

it('stops holding as soon as the owner aborts', async () => {
  const h = harness(10_000);
  h.steer();
  h.source.push({ type: 'result', uuid: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.received.map((e) => e.uuid)).toEqual(['first']);
  h.source.close();
  await h.consumed;
});
