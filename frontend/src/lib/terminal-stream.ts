import { z } from 'zod';
import type { TerminalEvent } from '@mitzo/protocol';
import { readEventStream } from './event-stream';
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
  for await (const event of readEventStream(body)) yield Event.parse(event);
}
