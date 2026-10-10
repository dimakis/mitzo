import { it, expect } from 'vitest';
import { readTerminalStream } from './terminal-stream';
function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}
it('decodes split snapshots and output frames without merging commands or dropping unicode', async () => {
  const events = [];
  for await (const event of readTerminalStream(
    stream([
      'data: {"type":"snap',
      'shot","data":"λ","seq":1}\n',
      '\ndata: {"type":"output","data":"next","seq":2}\n\n',
    ]),
  ))
    events.push(event);
  expect(events).toEqual([
    { type: 'snapshot', data: 'λ', seq: 1 },
    { type: 'output', data: 'next', seq: 2 },
  ]);
});
it('rejects malformed frames and oversized buffered data', async () => {
  await expect(async () => {
    for await (const event of readTerminalStream(
      stream(['data: {"type":"execute","command":"rm"}\n\n']),
    ))
      void event;
  }).rejects.toThrow();
  await expect(async () => {
    for await (const event of readTerminalStream(stream(['data: ' + 'x'.repeat(1024 * 1024 + 1)])))
      void event;
  }).rejects.toThrow();
});
