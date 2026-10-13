import { z } from 'zod';
import {
  AgentLibraryVersionSchema,
  OrdinaryCodexContinuationCommandSchema,
  OrdinaryCodexFirstCommandSchema,
  SessionRuntimeBindingV1Schema,
} from '@mitzo/protocol';
import {
  evaluateChatRuntimeSelection,
  type ChatRuntimeInventory,
  type ChatRuntimeSelection,
} from './chat-runtime-selection';
const ref = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
const account = SessionRuntimeBindingV1Schema.shape.account
  .extend({ provider: z.enum(['openai-codex', 'openai']) })
  .strict();
const model = z.strictObject({
  id: ref,
  label: z.string().min(1).max(256),
  reasoningEfforts: z.array(z.string().min(1).max(64)).max(16).optional(),
  defaultReasoningEffort: z.string().min(1).max(64).optional(),
});
export const ExplicitLocalInventorySchema = z
  .strictObject({
    version: z.literal(1),
    authority: z.literal('configuration-only'),
    defaultLocation: z.literal('openshell'),
    capabilityRevision: ref,
    accounts: z
      .array(
        z.strictObject({
          account,
          label: z.string().min(1).max(256),
          models: z.array(model).min(1).max(256),
          modelDiscovery: z.strictObject({
            source: z.enum(['cached', 'configured']),
            stale: z.boolean(),
            updatedAt: z.number().finite().nonnegative().optional(),
          }),
        }),
      )
      .max(64),
    targets: z
      .array(
        z.strictObject({
          targetId: ref,
          targetRevision: ref,
          label: z.string().min(1).max(256),
          location: z.enum(['local', 'openshell']),
          harness: z.literal('codex'),
        }),
      )
      .max(64),
    routes: z
      .array(
        z.strictObject({
          account,
          targetId: ref,
          harness: z.literal('codex'),
          modes: z.array(z.enum(['ask', 'agent', 'auto'])).max(3),
          skillCeiling: z.literal('unsupported').optional(),
          capabilityRevision: ref.optional(),
        }),
      )
      .max(128),
    locations: z
      .array(
        z.strictObject({
          location: z.enum(['local', 'openshell']),
          status: z.enum(['unavailable', 'configured']),
          reason: z.string().min(1).max(200).optional(),
        }),
      )
      .max(2),
    agentProfiles: z.array(AgentLibraryVersionSchema).max(256),
  })
  .superRefine((data, ctx) => {
    if (
      new TextEncoder().encode(JSON.stringify(data)).length > 1048576 ||
      new Set(data.accounts.map((a) => a.account.accountId)).size !== data.accounts.length ||
      data.accounts.some((a) => new Set(a.models.map((m) => m.id)).size !== a.models.length) ||
      data.agentProfiles.some(
        (p) => p.definition.contextRecipe !== undefined || ('kind' in p && p.kind !== undefined),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid Local configuration inventory' });
  });
export type ExplicitLocalInventory = z.infer<typeof ExplicitLocalInventorySchema>;
/** Configuration completeness only. Dispatch always performs actual owning admission. */
export function normalizeLocalInventory(data: ExplicitLocalInventory): ChatRuntimeInventory {
  return {
    capabilityRevision: data.capabilityRevision,
    agentProfiles: data.agentProfiles,
    locations: data.locations.map((l) => ({
      location: l.location,
      available: l.status === 'configured',
      reason: l.reason
        ? ((
            {
              openshell_projection_pending: 'OpenShell execution choices are not available yet.',
              openshell_admission_pending: 'OpenShell command admission is not available yet.',
              custodian_requires_openshell: 'This server requires OpenShell execution.',
              target_unconfigured: 'Local Mac has no configured execution target.',
              accounts_unavailable: 'No compatible Local Mac account is configured.',
            } as Record<string, string>
          )[l.reason] ?? l.reason)
        : l.location === 'openshell'
          ? 'OpenShell is unavailable.'
          : 'Local Mac is unavailable.',
    })),
    routes: data.routes.map((route) => {
      const configured = data.accounts.find(
        (a) => JSON.stringify(a.account) === JSON.stringify(route.account),
      );
      const target = data.targets.find((target) => target.targetId === route.targetId);
      return {
        accountId: route.account.accountId,
        accountReference: route.account,
        targetId: route.targetId,
        location: target?.location ?? 'local',
        available: !!target && !!configured && !configured.modelDiscovery.stale,
        reason: 'Refresh the selected account and model before sending.',
        models: configured?.models ?? [],
      };
    }),
  };
}
export function prepareLocalFirstCommand(
  selection: ChatRuntimeSelection,
  inventory: ExplicitLocalInventory | null,
  input: {
    clientMsgId: string;
    repositoryWorkspaceId: string;
    mode: 'ask' | 'agent' | 'auto';
    text: string;
    images?: { data: string; mediaType: string }[];
  },
) {
  if (
    !inventory ||
    !selection.agentProfile ||
    ('kind' in selection.agentProfile && selection.agentProfile.kind !== undefined) ||
    !evaluateChatRuntimeSelection(selection, normalizeLocalInventory(inventory)).ready
  )
    return { request: null, reason: 'Review the selected execution choices before sending.' };
  const configured = inventory.accounts.find(
    (a) => a.account.accountId === selection.account?.accountId,
  );
  const route = inventory.routes.find(
    (r) =>
      r.account.accountId === configured?.account.accountId &&
      r.targetId === selection.execution.targetId,
  );
  if (!configured || !route?.modes.includes(input.mode))
    return { request: null, reason: 'Review the selected execution choices before sending.' };
  const label = selection.execution.location === 'local' ? 'Local' : 'OpenShell';
  const parsed = OrdinaryCodexFirstCommandSchema.safeParse({
    runOn: selection.execution.location,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    clientMsgId: input.clientMsgId,
    capabilityRevision: route.capabilityRevision ?? inventory.capabilityRevision,
    runtime: {
      account: configured.account,
      harness: 'codex',
      targetId: selection.execution.targetId,
      mode: input.mode,
    },
    selection: {
      version: 1,
      agent: {
        profileId: selection.agentProfile.profileId,
        revision: selection.agentProfile.revision,
      },
      model: selection.account!.model,
      thinking: selection.account!.reasoningEffort ?? null,
      context: { source: 'none', revision: null },
      permission: { mode: input.mode, revision: 0 },
    },
    payload: { text: input.text, ...(input.images?.length ? { images: input.images } : {}) },
  });
  if (parsed.success) return { request: parsed.data, reason: undefined };
  const reason = parsed.error.issues.some((issue) => issue.message === 'Command exceeds bound')
    ? `${label} commands must fit within 1 MiB. Remove or resize attachments, or shorten the message.`
    : parsed.error.issues.some((issue) => issue.path[0] === 'payload' && issue.path[1] === 'images')
      ? `Remove unsupported or malformed attachments before sending the ${label} command.`
      : parsed.error.issues.some((issue) => issue.path[0] === 'payload' && issue.path[1] === 'text')
        ? `Shorten the message before sending the ${label} command.`
        : 'Review the selected execution choices before sending.';
  return { request: null, reason };
}

export function buildLocalFirstCommand(...args: Parameters<typeof prepareLocalFirstCommand>) {
  return prepareLocalFirstCommand(...args).request;
}

export function prepareLocalContinuationCommand(
  selection: ChatRuntimeSelection,
  inventory: ExplicitLocalInventory | null,
  input: Parameters<typeof prepareLocalFirstCommand>[2] & { sessionId: string },
) {
  const first = prepareLocalFirstCommand(selection, inventory, input);
  if (!first.request) return first;
  const parsed = OrdinaryCodexContinuationCommandSchema.safeParse({
    ...first.request,
    sessionId: input.sessionId,
  });
  return parsed.success
    ? { request: parsed.data, reason: undefined }
    : { request: null, reason: 'Review conversation settings before sending.' };
}
