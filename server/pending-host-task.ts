import { AccountBindingSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { CodexNativeTurnTargetSchema } from './codex-conversation-store.js';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';

const reference = z.string().min(1).max(200).regex(/^\S+$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const identity = z.strictObject({
  dev: z.number().int().nonnegative().safe(),
  ino: z.number().int().nonnegative().safe(),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const localSource = z.strictObject({
  selection: z.literal('existing').optional(),
  repositoryId: reference,
  path,
  root: identity,
  commonDirectory: path,
  commonRoot: identity,
});
const taskIdentity: z.ZodType<RepositoryTaskCheckout> = z.strictObject({
  directory: path,
  featureBranch: reference,
  root: identity,
  git: identity,
  localSource: localSource.optional(),
  linkedGit: z.strictObject({ directory: path, identity }).optional(),
});
/** Private owner intent, never an API/model input or a filesystem grant. */
export const PendingHostTaskRequestSchema = z
  .strictObject({
    id: z.uuid(),
    binding: AccountBindingSchema,
    conversationId: reference,
    runtimeId: reference,
    runtimeBinding: SessionRuntimeBindingV2Schema,
    nativeTarget: CodexNativeTurnTargetSchema,
    prepareCallId: reference,
    requestHash: digest,
    taskRoot: path,
  })
  .refine(
    (value) =>
      value.runtimeBinding.harness.implementation === 'codex' &&
      value.runtimeBinding.execution.location === 'local' &&
      value.binding.accountId === value.runtimeBinding.account.accountId &&
      value.binding.provider === value.runtimeBinding.account.provider &&
      value.binding.profileRevision === value.runtimeBinding.account.profileRevision,
    'Exact local Codex account and target required',
  );
export type PendingHostTaskRequest = z.infer<typeof PendingHostTaskRequestSchema>;
export const PendingHostTaskReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    request: PendingHostTaskRequestSchema,
    rootIdentity: identity,
    directory: path,
    sourceDigest: digest,
    state: z.enum(['reserved', 'materializing', 'materialized', 'uncertain']),
    taskIdentity: taskIdentity.optional(),
  })
  .refine(
    (value) => (value.state === 'materialized') === (value.taskIdentity !== undefined),
    'Materialized custody requires the original task identity',
  );
export type PendingHostTaskReceipt = z.infer<typeof PendingHostTaskReceiptSchema>;
export interface PendingHostTaskEffectScope {
  readonly kind: 'local-repository-worktree';
  readonly intent: 'create' | 'use';
  readonly workspaceId: string;
  readonly featureBranch: string;
  readonly baseOid: string;
  readonly source: Readonly<{ path: string; gitDirectory: string; commonDirectory: string }>;
  readonly task: Readonly<{ taskRoot: string; directory: string; adminBasename: string }>;
}
export interface PendingHostTaskAccess {
  readonly path: string;
  readonly operation: 'read' | 'write';
  readonly phase: 'reserve' | 'materialize' | 'revalidate';
  readonly effectScope: PendingHostTaskEffectScope;
  readonly signal: AbortSignal;
}
export class PendingHostTaskError extends Error {
  constructor(
    readonly code:
      | 'pending_host_task_authority_required'
      | 'pending_host_task_access_required'
      | 'pending_host_task_ownership_changed'
      | 'pending_host_task_uncertain'
      | 'pending_host_task_invalid_input',
  ) {
    super(code);
  }
}
export function freezePendingHostTaskData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezePendingHostTaskData(item);
    Object.freeze(value);
  }
  return value;
}
