import { z } from 'zod';
import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';

export const CodexUserInput = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        header: z.string().max(80),
        question: z.string().min(1).max(4000),
        isOther: z.boolean(),
        isSecret: z.boolean(),
        options: z
          .array(
            z.object({ label: z.string().min(1).max(4000), description: z.string().max(4000) }),
          )
          .max(8)
          .nullable(),
      }),
    )
    .min(1)
    .max(4)
    .refine(
      (qs) =>
        new Set(qs.map((q) => q.id)).size === qs.length &&
        new Set(qs.map((q) => q.question)).size === qs.length,
    ),
});
/** Native questions are interactions, not tool approvals or public transcript tool results. */
export async function requestCodexUserInput(
  params: Record<string, unknown>,
  signal: AbortSignal,
  clientId: string,
  registry: SessionRegistry,
): Promise<Record<string, unknown>> {
  const input = CodexUserInput.parse(params);
  const result = await buildPermissionHandler(clientId, registry)(
    'AskUserQuestion',
    {},
    {
      signal,
      toolUseID: input.itemId,
      questions: input.questions.map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        options: q.options ?? [],
        multiSelect: false,
        isSecret: q.isSecret,
        allowFreeform: q.isOther || !q.options?.length,
      })),
    },
  );
  if (result.behavior !== 'allow') return { answers: {} };
  const answers = z.record(z.string(), z.string()).parse(result.updatedInput?.answers);
  return {
    answers: Object.fromEntries(
      input.questions.map((q) => [q.id, { answers: [answers[q.question]] }]),
    ),
  };
}
