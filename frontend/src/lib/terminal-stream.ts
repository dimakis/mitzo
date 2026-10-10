import { z } from 'zod';
import type { TerminalEvent } from '@mitzo/protocol';
const sequenced = { seq: z.number().int().nonnegative() };
const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), data: z.string(), ...sequenced }),
  z.object({ type: z.literal('output'), data: z.string(), ...sequenced }),
  z.object({ type: z.literal('exit'), ...sequenced }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
export async function* readTerminalStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<TerminalEvent> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw Error('Terminal stream exceeded limit');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield Event.parse(JSON.parse(data));
      }
      if (done) {
        if (buffer.trim()) throw Error('Incomplete terminal frame');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
