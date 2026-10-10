import { z } from 'zod';
import { SymposiumProfileDefinitionSchema, SymposiumProfileRecipeSchema } from '@mitzo/protocol';

// Editing must preserve incomplete values and whitespace. Publication still uses
// the server's strict portable-profile contract and original version fence.
const recipe = SymposiumProfileRecipeSchema.extend({
  skillRefs: z.array(z.string()),
  toolDefaults: SymposiumProfileRecipeSchema.shape.toolDefaults.extend({
    preferredTools: z.array(z.string()),
  }),
  compatibleProviders: SymposiumProfileRecipeSchema.shape.compatibleProviders.unwrap().array(),
});
const definition = SymposiumProfileDefinitionSchema.extend({
  name: z.string(),
  descriptor: z.string().optional(),
  description: z.string().optional(),
  role: z.string(),
  instructions: z.string(),
  expectedOutput: z.string(),
  acceptanceCriteria: z.array(z.string()),
  modelPolicyRole: z.string(),
  recipe: recipe.optional(),
});
const editor = z.strictObject({
  profileId: z.string().min(1),
  definition,
  expectedVersion: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative(),
  publishedRevision: z.number().int().positive().nullable(),
});
const recovery = z.strictObject({ version: z.literal(1), editor, saveKey: z.string().uuid() });
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
    return parsed.success ? { editor: parsed.data.editor, saveKey: parsed.data.saveKey } : null;
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
