import { z } from 'zod';

const token = z.string().regex(/^\S{1,200}$/);
const UncertainOperationsSchema = z
  .array(
    z.object({
      tool: token,
      toolUseId: token.optional(),
      requestHash: token.optional(),
      // Owning tool schemas accept any 1-200 character request ID, including spaces.
      requestId: z.string().min(1).max(200).optional(),
    }),
  )
  .min(1)
  .max(16);

/** A plain ID is shown as-is; one with whitespace, quotes or control characters
 * is JSON-quoted so the operator can reuse it exactly and no characters can
 * reshape the notice text. */
function formatRequestId(requestId: string): string {
  return /^[\x21-\x7e]+$/.test(requestId) && !requestId.includes('"')
    ? requestId
    : JSON.stringify(requestId);
}

/** Phone notice for tool calls whose effect Mitzo could not confirm. It names
 * the operation and its ORIGINAL request ID: a retry must reuse that ID so the
 * owner can deduplicate it, and nothing is ever replayed automatically. Only
 * identity is shown; input values never reach this text. */
export function uncertainOperationsNotice(value: unknown): string | undefined {
  const parsed = UncertainOperationsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const named = parsed.data
    .map(({ tool, requestId }) =>
      requestId ? `${tool} (request ID ${formatRequestId(requestId)})` : `${tool} (no request ID)`,
    )
    .join('; ');
  const reuse = parsed.data.some(({ requestId }) => requestId);
  return (
    `Outcome unknown for: ${named}. It may or may not have taken effect, and nothing was replayed. ` +
    'Next safe step: ask the agent to read the current state' +
    (reuse
      ? ', or to re-run the same call with the same request ID. Do not use a new ID.'
      : ' before repeating anything.')
  );
}
