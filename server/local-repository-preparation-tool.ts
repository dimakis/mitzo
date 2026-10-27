import { z } from 'zod';
import type { ToolDefinition } from '@mitzo/harness';
import { inputSchema as localRepositoryPreparationInputSchema } from './local-repository-preparation-authorization.js';

export const localRepositoryPreparationDefinition: ToolDefinition = {
  name: 'PrepareLocalRepository',
  description:
    'Prepare an isolated repository task from an existing Mac path, clone an approved remote URL, or initialize a new local Git repository. Existing and cloned sources use the freshly acquired remote default branch unless an explicit base is selected. Source work remains intact. The task becomes active after this turn finishes. Creating remote hosting requires a separate explicit request.',
  input_schema: z.toJSONSchema(localRepositoryPreparationInputSchema),
};
export const LOCAL_REPOSITORY_PREPARATION_INSTRUCTIONS =
  'Use PrepareLocalRepository for any repository task. Supply path (existing Mac checkout), or source {kind:"existing",path:"..."}, source {kind:"clone",url:"..."}, or source {kind:"new",name:"..."}. New initializes local Git only; remote hosting requires a separate explicit user request. Omitted base selects the freshly acquired remote default branch for existing/clone sources. Use base {kind:"ref",ref:"..."} for an explicitly selected branch, commit or HEAD; existing repositories without a remote require this explicit local base. The source checkout may be old or dirty and remains intact. Preparation uses current acquisition/task approval; discovery grants no writes. A repeated call reuses or observes the existing task. Use newCheckout:true only when the user explicitly wants another checkout. On state active, continue in the current task. On state pending, reconcile the returned existing preparation rather than allocating a replacement. On materialized, report the location and finish this turn; the completed-turn boundary adopts it in this same conversation. Do not retarget current cwd or start another chat.';
