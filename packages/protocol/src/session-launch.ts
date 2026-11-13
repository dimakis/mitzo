import { z } from 'zod';
import { AgentProfileSelectionSchema } from './agent-library.js';
import { SessionRuntimeBindingV1Schema } from './session-runtime-binding.js';
import { TelosWorkArtifactReferenceSchema } from './telos-work.js';
import { TelosWorkRoleContextReviewSchema } from './telos-work-role-presentation.js';
import { TelosExistingChatAdoptionSchema } from './telos-ordinary-work.js';

const reference = z.string().min(1).max(200).regex(/^\S+$/);
const account = z.strictObject({
  accountId: reference,
  model: reference,
  reasoningEffort: reference.nullable().optional(),
});
const execution = z.strictObject({
  location: z.enum(['local', 'openshell']),
  targetId: reference.nullable(),
});
/** Saved editable intent, never credentials, grants, capability observations or
 * ownership of a prepared checkout. Every launch revalidates the selection. */
export const SessionLaunchConfigSchema = z.strictObject({
  version: z.literal(1),
  runtime: z.strictObject({
    version: z.literal(1),
    account: account.nullable(),
    accountReference: SessionRuntimeBindingV1Schema.shape.account.nullable().optional(),
    agentProfile: AgentProfileSelectionSchema.nullable(),
    execution,
  }),
  mode: z.enum(['ask', 'agent', 'auto']),
  isolation: z.boolean(),
  repositoryWorkspaceId: reference.nullable(),
  contextBlocks: z.array(z.string().min(1).max(32000)).max(100),
  extraTools: z.array(reference).max(100),
});
export type SessionLaunchConfig = z.infer<typeof SessionLaunchConfigSchema>;

export function sessionLaunchHandoverUrl(proposalId: string): string {
  return `/api/session-launch/requests/${encodeURIComponent(proposalId)}/handover.md`;
}
/** Only the retained handover endpoint can bypass workspace file resolution. */
export function isSessionLaunchHandoverUrl(url: string): boolean {
  return /^\/api\/session-launch\/requests\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/handover\.md$/i.test(
    url,
  );
}

/** Shared presentation of the startup route's static limits. Catalog, account
 * and tool availability still require current controller qualification. */
export function sessionLaunchConfigurationReason(config: SessionLaunchConfig): string | null {
  if (config.runtime.execution.location !== 'local')
    return 'Agent-created sessions currently require Local Mac.';
  if (!config.isolation || config.repositoryWorkspaceId !== null)
    return 'Choose an independent ordinary workspace. Repository session launching is not available yet.';
  if (config.contextBlocks.length)
    return 'Selected context blocks are unavailable for this startup route. Put the handover text in Handoff prompt and clear Context before starting.';
  return null;
}

export const SessionLaunchOverridesSchema = SessionLaunchConfigSchema.omit({
  version: true,
  runtime: true,
})
  .partial()
  .extend({
    runtime: SessionLaunchConfigSchema.shape.runtime
      .omit({ version: true })
      .partial()
      .extend({
        account: account.partial().nullable().optional(),
        execution: execution.partial().optional(),
      })
      .optional(),
  });
export const StartSessionInputSchema = z.strictObject({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(32000),
  overrides: SessionLaunchOverridesSchema.optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;
/** Host-derived canonical responsibility. This is never an approval edit or a
 * saved default; selecting a child cannot grant authority over another item. */
export const TelosSessionLaunchScopeSchema = z.strictObject({
  version: z.literal(1),
  parentItemId: reference,
  parentAssignmentRevision: z.number().int().positive().safe(),
  itemId: reference,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(['lead', 'worker']),
  sourceSnapshotIds: z.array(reference).max(100),
  artifactRefs: z.array(TelosWorkArtifactReferenceSchema).max(100),
  adoption: TelosExistingChatAdoptionSchema.extend({
    title: z.string().min(1).max(1000),
  }).optional(),
});
export type TelosSessionLaunchScope = z.infer<typeof TelosSessionLaunchScopeSchema>;
export const TelosCreateSessionInputSchema = StartSessionInputSchema.extend({
  existingConversationId: reference
    .optional()
    .describe(
      'Explicit adoption of this exact compatible existing ordinary chat. Review its retained settings and bounded work context; never allocate a replacement or start a command.',
    ),
  itemId: reference,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSnapshotIds: z.array(reference).max(100).default([]),
  artifactRefs: z.array(TelosWorkArtifactReferenceSchema).max(100).default([]),
});
export type TelosCreateSessionInput = z.infer<typeof TelosCreateSessionInputSchema>;
export const SessionLaunchStateSchema = z.enum([
  'pending',
  'starting',
  'created',
  'running',
  'failed',
  'cancelled',
  'uncertain',
  'assigned',
]);
export const SessionLaunchRecordSchema = z.strictObject({
  proposalId: z.uuid(),
  requestId: z.uuid(),
  sourceSessionId: reference,
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(32000),
  configuration: SessionLaunchConfigSchema,
  telos: TelosSessionLaunchScopeSchema.optional(),
  telosReview: TelosWorkRoleContextReviewSchema.optional(),
  revision: z.number().int().positive(),
  state: SessionLaunchStateSchema,
  childSessionId: reference.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  error: z.string().max(1000).optional(),
});
export type SessionLaunchRecord = z.infer<typeof SessionLaunchRecordSchema>;
export const SessionChatLinkSchema = z.strictObject({
  sessionId: reference,
  title: z.string(),
  available: z.boolean(),
});
export type SessionChatLink = z.infer<typeof SessionChatLinkSchema>;
export const SessionLaunchDefaultsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  configuration: SessionLaunchConfigSchema.nullable(),
});
export type SessionLaunchDefaults = z.infer<typeof SessionLaunchDefaultsSchema>;
export const SessionLaunchDefaultSaveSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  configuration: SessionLaunchConfigSchema.nullable(),
});
export const SessionLaunchApprovalSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  title: StartSessionInputSchema.shape.title,
  prompt: StartSessionInputSchema.shape.prompt,
  configuration: SessionLaunchConfigSchema,
  saveAsDefault: z.boolean().default(false),
});

/** Merge only declared intent fields. Changing account identity invalidates its
 * remembered public binding unless an explicit replacement is supplied. */
export function resolveSessionLaunchConfig(
  saved: SessionLaunchConfig,
  raw?: z.infer<typeof SessionLaunchOverridesSchema>,
): SessionLaunchConfig {
  const overrides = SessionLaunchOverridesSchema.parse(raw ?? {});
  const runtime = {
    ...saved.runtime,
    ...overrides.runtime,
    account:
      overrides.runtime?.account === null
        ? null
        : overrides.runtime?.account === undefined
          ? saved.runtime.account
          : { ...saved.runtime.account, ...overrides.runtime.account },
    execution: { ...saved.runtime.execution, ...overrides.runtime?.execution },
  };
  if (
    overrides.runtime?.execution?.location &&
    overrides.runtime.execution.location !== saved.runtime.execution.location &&
    overrides.runtime.execution.targetId === undefined
  )
    runtime.execution.targetId = null;
  if (
    (overrides.runtime?.account === null ||
      (overrides.runtime?.account?.accountId !== undefined &&
        overrides.runtime.account.accountId !== saved.runtime.account?.accountId)) &&
    overrides.runtime.accountReference === undefined
  )
    runtime.accountReference = null;
  return SessionLaunchConfigSchema.parse({ ...saved, ...overrides, runtime });
}
