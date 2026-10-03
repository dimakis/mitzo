import { createHash } from 'node:crypto';
import { z } from 'zod';

const bytes = z
  .number()
  .int()
  .min(0)
  .max(4 * 1024 * 1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
const textSummary = z.strictObject({ utf8Bytes: bytes, sha256: digest });
export const TurnInputMetadataSchema = z
  .strictObject({
    version: z.literal(1),
    requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    commandId: id,
    threadId: id,
    inputCount: z.number().int().min(1).max(64),
    inputs: z
      .array(
        z.discriminatedUnion('type', [
          textSummary.extend({ type: z.literal('text') }),
          z.strictObject({ type: z.literal('image') }),
        ]),
      )
      .min(1)
      .max(64),
    inputUtf8Bytes: bytes,
    inputSha256: digest,
    additionalContext: textSummary.nullable(),
  })
  .refine((value) => value.inputCount === value.inputs.length);
export type TurnInputMetadata = z.infer<typeof TurnInputMetadataSchema>;
export const TurnInputWriteSchema = TurnInputMetadataSchema.safeExtend({
  boundary: z.enum(['prepared', 'write_queued', 'write_completed', 'write_failed']),
});
export type TurnInputWrite = z.infer<typeof TurnInputWriteSchema>;
export type TurnInputWriteObserver = (receipt: Readonly<TurnInputWrite>) => void;

const summary = (text: string) => ({
  utf8Bytes: Buffer.byteLength(text, 'utf8'),
  sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
});
/** Only credential-free metadata escapes this exact serialized host frame boundary. */
function summarizeFrame(frame: string): TurnInputMetadata {
  if (Buffer.byteLength(frame, 'utf8') > 4 * 1024 * 1024)
    throw new Error('Native turn input diagnostic bound exceeded');
  const { id: requestId, params } = z
    .object({
      id: z.number(),
      method: z.literal('turn/start'),
      params: z
        .object({
          threadId: id,
          clientUserMessageId: id,
          input: z
            .array(z.object({ type: z.enum(['text', 'image']), text: z.string().optional() }))
            .min(1)
            .max(64),
        })
        .passthrough(),
    })
    .parse(JSON.parse(frame));
  const encodedInput = JSON.stringify(
    (JSON.parse(frame) as { params: { input: unknown } }).params.input,
  );
  const inputs = params.input.map((item) => {
    if (item.type === 'image') return { type: 'image' as const };
    if (typeof item.text !== 'string') throw new Error('Native turn text diagnostic unavailable');
    return { type: 'text' as const, ...summary(item.text) };
  });
  const input = summary(encodedInput);
  return TurnInputMetadataSchema.parse({
    version: 1,
    requestId,
    commandId: params.clientUserMessageId,
    threadId: params.threadId,
    inputCount: inputs.length,
    inputs,
    inputUtf8Bytes: input.utf8Bytes,
    inputSha256: input.sha256,
    additionalContext:
      params.additionalContext === undefined
        ? null
        : summary(JSON.stringify(params.additionalContext)),
  });
}

export function summarizeTurnStartFrame(frame: string): TurnInputMetadata {
  try {
    return summarizeFrame(frame);
  } catch {
    throw new Error('Native turn input diagnostic unavailable');
  }
}
