import { z } from 'zod';

const schema = z.strictObject({
  text: z.string(),
  prompt: z.string(),
  allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/)).optional(),
});
export type OrdinarySkillContext = z.infer<typeof schema>;

/** Snapshot the existing command record before admission callbacks can mutate
 * caller-owned arrays. An absent legacy ceiling and deny-all remain distinct. */
export function parseOrdinarySkillContext(input: unknown): OrdinarySkillContext {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw Error('Invalid frozen skill context');
  const { text, prompt, allowedTools } = parsed.data;
  return { text, prompt, ...(allowedTools !== undefined ? { allowedTools } : {}) };
}
