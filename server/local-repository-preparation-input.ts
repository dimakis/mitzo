import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { CodexToolFailure } from './codex-tool-failure.js';
import {
  RepositoryBaseIntentSchema,
  RepositorySourceIntentSchema,
} from './local-repository-base.js';

// Shared public contract and decoder; importing the tool definition needs no
// authorization service. JSON Schema needs an explicit oneOf for the refinement.
export const inputSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => isAbsolute(path) && resolve(path) === path)
      .describe('Existing absolute Mac checkout path, not a destination. Omit when using source.')
      .optional(),
    source: RepositorySourceIntentSchema.describe(
      'Choose existing, clone or new. Omit path when using source. New name is a label; Mitzo assigns the isolated task directory.',
    ).optional(),
    base: RepositoryBaseIntentSchema.describe(
      'Omit to use the remote default branch. For an existing repository without a remote, explicitly select ref HEAD. New repositories start on main.',
    ),
    newCheckout: z
      .literal(true)
      .describe('Only when the user explicitly requests an additional checkout; never for retries.')
      .optional(),
  })
  .refine(
    (input) => Boolean(input.path) !== Boolean(input.source),
    'Choose exactly one existing path or repository source',
  )
  .meta({
    examples: [
      { source: { kind: 'new', name: 'my-project' } },
      { path: '/absolute/existing-repo', base: { kind: 'ref', ref: 'HEAD' } },
      { source: { kind: 'clone', url: 'https://example.invalid/team/repo.git' } },
    ],
  });

/** Validation precedes preparation/approval. Never expose raw Zod issues, which
 * can contain private input, or imply uncertain effects for a rejected call. */
export function parseLocalRepositoryPreparationInput(
  rawInput: unknown,
): z.infer<typeof inputSchema> {
  try {
    return inputSchema.parse(structuredClone(rawInput));
  } catch {
    throw new CodexToolFailure('invalid_input', {
      stage: 'repository_preparation',
      reason: 'invalid_input',
      effectStatus: 'not_started',
    });
  }
}
