import { z } from 'zod';
import { AgentLibraryEditableDefinitionSchema } from '@mitzo/protocol';

// Editing retains incomplete values; publication uses the strict portable schema.
const editor = z.strictObject({
  profileId: z.string().min(1),
  definition: AgentLibraryEditableDefinitionSchema,
  expectedVersion: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative(),
  publishedRevision: z.number().int().positive().nullable(),
});
const recovery = z.strictObject({
  version: z.literal(1),
  editor,
  saveKey: z.string().uuid(),
  dirty: z.boolean().optional(),
  reviewedContext: z
    .string()
    .max(1024 * 1024)
    .optional(),
});
export type AgentLibraryEditor = z.infer<typeof editor>;
export type AgentLibraryWorkingCopy = Omit<z.infer<typeof recovery>, 'version'>;
const KEY = 'mitzo-agent-library-working-copy';
let memory: AgentLibraryWorkingCopy | null = null;
let pendingStorage = false;

export function loadAgentLibraryWorkingCopy(): AgentLibraryWorkingCopy | null {
  if (pendingStorage) return memory;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return pendingStorage ? memory : null;
    const parsed = recovery.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      editor: parsed.data.editor,
      saveKey: parsed.data.saveKey,
      ...(parsed.data.dirty === undefined ? {} : { dirty: parsed.data.dirty }),
      ...(parsed.data.reviewedContext === undefined
        ? {}
        : { reviewedContext: parsed.data.reviewedContext }),
    };
  } catch {
    return memory;
  }
}
export function saveAgentLibraryWorkingCopy(copy: AgentLibraryWorkingCopy | null): boolean {
  memory = copy;
  try {
    if (copy) sessionStorage.setItem(KEY, JSON.stringify({ version: 1, ...copy }));
    else sessionStorage.removeItem(KEY);
    pendingStorage = false;
    return true;
  } catch {
    pendingStorage = true;
    return false;
  }
}
