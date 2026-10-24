import { z } from 'zod';
import type { ToolDefinition } from '@mitzo/harness';
import { inputSchema as localRepositoryPreparationInputSchema } from './local-repository-preparation-authorization.js';

export const localRepositoryPreparationDefinition: ToolDefinition = {
  name: 'PrepareLocalRepository',
  description:
    'Create an isolated task folder for an existing Mac repository after you approve the displayed repository and task changes. Keeps source work and this turn’s working directory intact. The prepared task becomes active after this turn finishes.',
  input_schema: z.toJSONSchema(localRepositoryPreparationInputSchema),
};
export const LOCAL_REPOSITORY_PREPARATION_INSTRUCTIONS =
  'When the user task needs an isolated task checkout of the chosen existing Mac repository, call PrepareLocalRepository with its explicit path. It always requests exact one-use source/task approval, including in Ask, Agent and Auto; selection or discovery grants no write access. On a materialized result, report the prepared location and finish the current turn. The existing completed-turn admission adopts that task for the original request at the next safe command boundary; do not retarget the current cwd or start a second chat. Refusal or an uncertain handoff requires the existing access/reconciliation path, not repeated effects.';
