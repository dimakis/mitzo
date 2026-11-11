import { z } from 'zod';
import { GithubLogReadSchema } from './github-log-read.js';

export const taskExecutionSchema = z.strictObject({
  operation: z.enum(['authorize', 'status', 'run', 'github_read', 'commit', 'revoke']),
  grantId: z.uuid().optional(),
  requestId: z.uuid().optional(),
  title: z.string().trim().min(1).max(240).optional(),
  memberSessionIds: z.array(z.string().min(1).max(200)).max(19).optional(),
  repositories: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .max(20)
    .optional(),
  network: z.enum(['none', 'loopback', 'internet']).optional(),
  durationMinutes: z.number().int().min(1).max(480).optional(),
  command: z.string().min(1).max(32000).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1).max(120000).optional(),
  endpoint: z.string().min(1).max(1000).optional(),
  access: z.enum(['public', 'authenticated']).optional(),
  view: z.enum(['summary', 'full']).optional(),
  log: GithubLogReadSchema.optional(),
  files: z.array(z.string().min(1)).min(1).max(64).optional(),
  message: z.string().min(1).max(4000).optional(),
});
export const taskExecutionDefinition = {
  name: 'TaskExecution',
  description:
    'Authorize one bounded task for this chat and selected same-operator workers, then run routine host-workspace commands, local commits and repository reads without repeated command approvals. Authorize reuses matching development and repository-read grants from Access; otherwise it requests one task approval. Inherited authority ends when its parent grant expires or is revoked. Authorize requires title and requestId; select memberSessionIds, repositories, network (none/loopback/internet) and durationMinutes. The card displays exact registered host roots and accounts. Run/commit/github_read require grantId and a fresh requestId; run uses command and optional cwd/timeoutMs, commit uses files/message, github_read uses endpoint/access/view; for authenticated CI job logs, add log: {query, offset, limit} to /repos/OWNER/REPO/actions/jobs/JOB_ID/logs. query is literal, offset counts UTF-16 characters, limit is at most 16000; follow nextOffset until null. Logs over 8 MiB fail explicitly. Status lists usable grants; revoke ends a task owned by this chat. Reuse requestId after uncertainty; an interrupted run is never replayed automatically. Native sandbox tools keep their own policy. This does not authorize merges, production, host credentials or writes outside the selected task roots.',
  input_schema: z.toJSONSchema(taskExecutionSchema),
};
export const TASK_EXECUTION_INSTRUCTIONS =
  '\nFor an authorized implementation task, inspect TaskExecution status and reuse an applicable grant. If needed, request one bounded task authorization, including the selected worker chat IDs and repositories. Use TaskExecution run for routine tests/builds and command variants, github_read for CI/repository diagnostics, and commit for local commits. These operations execute in the displayed host task checkout, including from an OpenShell chat; do not assume a separate container filesystem is synchronized. Share the grantId with selected workers; messages alone grant no authority. Preserve uncertain run receipts and check actual work before starting another run. Production and merge authority remain separate.\n';
