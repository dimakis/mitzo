import { selectedRuntimeRoute } from './chat-runtime-route';
import { sha256Hex } from './browser-crypto';
import { z } from 'zod';
import {
  createOrdinaryFreshPermission,
  NativeContinuationConstraintSchema,
  type NativeContinuationConstraint,
  AgentLibraryVersionSchema,
  AgentProfileSelectionSchema,
  type AgentLibraryVersion,
  type AgentContextSnapshot,
  OrdinaryRuntimeContinuationCommandSchema,
  OrdinaryRuntimeFirstCommandSchema,
  SessionRuntimeBindingV1Schema,
} from '@mitzo/protocol';
import {
  evaluateChatRuntimeSelection,
  type ChatRuntimeInventory,
  type ChatRuntimeSelection,
} from './chat-runtime-selection';
const ref = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
const account = SessionRuntimeBindingV1Schema.shape.account
  .extend({ provider: z.enum(['openai-codex', 'openai', 'anthropic-vertex', 'google-vertex']) })
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
          harness: z.enum(['codex', 'responses', 'claude-sdk', 'gemini']),
        }),
      )
      .max(64),
    routes: z
      .array(
        z.strictObject({
          account,
          targetId: ref,
          location: z.enum(['local', 'openshell']).optional(),
          harness: z.enum(['codex', 'responses', 'claude-sdk', 'gemini']),
          modes: z.array(z.enum(['ask', 'agent', 'auto'])).max(3),
          skillCeiling: z.literal('unsupported').optional(),
          agentProfiles: z.array(AgentProfileSelectionSchema).max(256).optional(),
          agentProfileRejections: z
            .array(
              z.strictObject({
                agent: AgentProfileSelectionSchema,
                reason: z.enum([
                  'provider_incompatible',
                  'sandbox_context_preset_unconfigured',
                  'native_pack_context_unavailable',
                  'native_context_unavailable',
                  'tool_selection_unavailable',
                ]),
              }),
            )
            .max(256)
            .optional(),
          capabilityRevision: ref.optional(),
          models: z.array(model).min(1).max(256).optional(),
          modelDiscovery: z
            .strictObject({
              source: z.enum(['cached', 'configured']),
              stale: z.boolean(),
              updatedAt: z.number().finite().nonnegative().optional(),
            })
            .optional(),
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
        (p) =>
          p.definition.contextRecipe?.source === 'packs' ||
          p.contentHash !== sha256Hex(JSON.stringify(p.definition)),
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
      const candidates = data.targets.filter(
        (target) =>
          target.targetId === route.targetId &&
          target.harness === route.harness &&
          (!route.location || target.location === route.location),
      );
      const target = candidates.length === 1 ? candidates[0] : undefined;
      return {
        accountId: route.account.accountId,
        accountReference: route.account,
        targetId: route.targetId,
        location: target?.location ?? 'local',
        available:
          !!target && !!configured && !(route.modelDiscovery ?? configured.modelDiscovery).stale,
        reason:
          candidates.length > 1
            ? 'The configured target identity is ambiguous. Refresh execution choices.'
            : 'Refresh the selected account and model before sending.',
        models: route.models ?? configured?.models ?? [],
        agentProfiles: route.agentProfiles,
        agentProfileRejections: route.agentProfileRejections,
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
    sourceSnapshots?: import('@mitzo/protocol').SourceSnapshot[];
    retainedAgentProfile?: AgentLibraryVersion;
    retainedAgentContext?: AgentContextSnapshot;
    nativeConstraint?: NativeContinuationConstraint;
  },
) {
  if (!inventory || !selection.agentProfile)
    return { request: null, reason: 'Review the selected execution choices before sending.' };
  const readiness = evaluateChatRuntimeSelection(selection, normalizeLocalInventory(inventory));
  if (!readiness.ready)
    return {
      request: null,
      reason:
        readiness.issues[0]?.message ?? 'Review the selected execution choices before sending.',
    };
  const selectedProfile = inventory.agentProfiles.find(
    (profile) =>
      profile.profileId === selection.agentProfile!.profileId &&
      profile.revision === selection.agentProfile!.revision &&
      profile.kind === selection.agentProfile!.kind,
  );
  if (
    !selectedProfile ||
    selectedProfile.contentHash !== sha256Hex(JSON.stringify(selectedProfile.definition))
  )
    return {
      request: null,
      reason: 'The selected agent snapshot is unavailable. Refresh to retry.',
    };
  const profile = input.retainedAgentProfile ?? selectedProfile;
  if (
    profile.profileId !== selectedProfile.profileId ||
    profile.revision !== selectedProfile.revision ||
    profile.kind !== selectedProfile.kind ||
    profile.contentHash !== selectedProfile.contentHash ||
    profile.contentHash !== sha256Hex(JSON.stringify(profile.definition))
  )
    return {
      request: null,
      reason:
        'The pinned agent snapshot changed. Preserve this conversation and review its original settings.',
    };
  const recipe = profile.definition.contextRecipe;
  if (recipe?.source === 'packs')
    return {
      request: null,
      reason:
        'Reusable context packs require a trusted native continuation barrier; native Codex context admission is unavailable.',
    };
  const context = recipe
    ? { source: recipe.source, revision: sha256Hex(JSON.stringify(recipe)) }
    : { source: 'none' as const, revision: null };
  const retained = input.retainedAgentContext;
  if (
    retained &&
    (retained.profileId !== profile.profileId ||
      retained.revision !== profile.revision ||
      retained.profileHash !== profile.contentHash ||
      retained.source !== context.source ||
      retained.recipeHash !== context.revision)
  )
    return {
      request: null,
      reason:
        'The pinned context snapshot changed. Preserve this conversation and review its original settings.',
    };
  const route = selectedRuntimeRoute(selection, inventory);
  const configured =
    route &&
    inventory.accounts.find(
      (a) =>
        a.account.accountId === route.account.accountId &&
        a.account.provider === route.account.provider &&
        a.account.profileRevision === route.account.profileRevision,
    );
  if (!configured || !route?.modes.includes(input.mode))
    return { request: null, reason: 'Review the selected execution choices before sending.' };
  const label = selection.execution.location === 'local' ? 'Local' : 'OpenShell';
  const parsed = OrdinaryRuntimeFirstCommandSchema.safeParse({
    runOn: selection.execution.location,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    clientMsgId: input.clientMsgId,
    capabilityRevision: route.capabilityRevision ?? inventory.capabilityRevision,
    runtime: {
      account: configured.account,
      harness: route.harness,
      targetId: selection.execution.targetId,
      mode: input.mode,
    },
    selection: {
      version: 1,
      agent: {
        profileId: selection.agentProfile.profileId,
        revision: selection.agentProfile.revision,
        ...(selection.agentProfile.kind ? { kind: selection.agentProfile.kind } : {}),
      },
      model: selection.account!.model,
      thinking: selection.account!.reasoningEffort ?? null,
      context,
      permission: createOrdinaryFreshPermission(input.mode),
    },
    payload: {
      text: input.text,
      ...(input.sourceSnapshots?.length ? { sourceSnapshots: input.sourceSnapshots } : {}),
      ...(input.images?.length ? { images: input.images } : {}),
    },
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
  const gemini =
    input.nativeConstraint !== undefined ||
    selection.accountReference?.provider === 'google-vertex' ||
    inventory?.routes.some(
      (route) =>
        route.harness === 'gemini' &&
        route.account.accountId === selection.account?.accountId &&
        route.targetId === selection.execution.targetId,
    );
  if (gemini) {
    const constraint = NativeContinuationConstraintSchema.safeParse(input.nativeConstraint);
    if (!constraint.success)
      return {
        request: null,
        reason: 'Original Gemini continuation settings are unavailable. Refresh before sending.',
      };
    if (
      selection.account?.model !== constraint.data.model ||
      (selection.account?.reasoningEffort ?? null) !== constraint.data.thinking
    )
      return { request: null, reason: constraint.data.reason };
  }
  const first = prepareLocalFirstCommand(selection, inventory, input);
  if (!first.request) return first;
  const parsed = OrdinaryRuntimeContinuationCommandSchema.safeParse({
    ...first.request,
    sessionId: input.sessionId,
  });
  return parsed.success
    ? { request: parsed.data, reason: undefined }
    : { request: null, reason: 'Review conversation settings before sending.' };
}
