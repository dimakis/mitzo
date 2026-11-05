import { expect, it } from 'vitest';
import { readEventStream } from '../event-stream';

it('parses fragmented UTF-8 SSE frames and CRLF without losing or duplicating an event', async () => {
  const bytes = new TextEncoder().encode(
    'data: {"text":"é"}\r\n\r\n: heartbeat\n\ndata: {"text":"second"}\n\n',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const values = [];
  for await (const value of readEventStream(stream)) values.push(value);
  expect(values).toEqual([{ text: 'é' }, { text: 'second' }]);
});
it('refuses incomplete or oversized frames and releases the stream', async () => {
  for (const value of ['data: {', 'a'.repeat(1024 * 1024 + 1)]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });
    await expect(
      (async () => {
        for await (const _event of readEventStream(stream)) {
          void _event;
        }
      })(),
    ).rejects.toThrow();
    expect(stream.locked).toBe(false);
  }
});
