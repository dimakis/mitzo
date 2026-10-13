import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  SessionRuntimeBindingV1Schema,
  OrdinaryLocalCommandSelectionSchema,
  AgentLibraryVersionSchema,
  AgentContextSnapshotSchema,
  AccountBindingSchema,
  type SessionRuntimeBindingV2,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type {
  OrdinaryLocalCodexCapabilityCatalog,
  OrdinaryLocalCodexTarget,
} from './ordinary-local-codex-capabilities.js';
import { assertNativeCodexContextAdmission } from './native-codex-context-admission.js';

const reference = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
const Selection = OrdinaryLocalCommandSelectionSchema;
const Request = z.strictObject({
  clientMsgId: reference,
  capabilityRevision: reference,
  runtime: z.strictObject({
    account: SessionRuntimeBindingV1Schema.shape.account,
    harness: z.literal('codex'),
    targetId: reference,
    mode: z.enum(['ask', 'agent', 'auto']),
  }),
  selection: Selection,
  payload: z
    .record(z.string(), z.json())
    .refine((payload) => Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 1048576),
});
export type OrdinaryLocalCodexCommandRequest = z.infer<typeof Request>;
export interface OrdinaryLocalCodexAdmissionExpectation {
  binding: SessionRuntimeBindingV2;
  hostId: string;
  runtimeContractRevision: string;
  capabilityRevision: string;
  workspace: { workspaceId: string; cwd: string };
  selection: z.infer<typeof Selection>;
  agentProfile?: Meta['agentProfile'];
  agentContext?: Meta['agentContext'];
}
/** Injection belongs exclusively to the actual host-login/runtime/agent-context
 * owning authority. It must independently observe exact host, runtime, account,
 * model/thinking, source/context and permission authority, reject stale/revoked
 * authorization and hold its revocation/lifecycle fence through operation.
 * Catalog metadata and client receipts cannot implement this contract. No default
 * verifier exists; absent a qualified owner, admission remains unavailable. */
export interface OrdinaryLocalCodexAdmissionLease {
  /** Recheck expiry/revocation and the exact admission tuple under the owning fence. */
  assertCurrent(): Promise<void>;
}
export interface OrdinaryLocalCodexAdmissionAuthority {
  withAdmission<T>(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    operation: (lease: OrdinaryLocalCodexAdmissionLease) => Promise<T>,
  ): Promise<T>;
}
/** An owned runtime may need native account/read to qualify. Its bootstrap is
 * an external effect too: first freeze intent and claim durable uncertainty.
 * The owner validates server configuration before claim, then retains the same
 * isolated login/client through qualification and dispatch. A false claim must
 * return without any bootstrap effects; it never recovers an uncertain launch. */
export interface OrdinaryLocalCodexBootstrapAuthority {
  withBootstrap<T>(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    claimBeforeBootstrap: () => boolean,
    operation: (lease: OrdinaryLocalCodexAdmissionLease) => Promise<T>,
  ): Promise<T | undefined>;
}
export interface OrdinaryLocalCodexAdmissionEffects {
  /** Owning workspace authority creates/reuses the already reserved exact workspace. */
  prepareWorkspace(expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>): Promise<void>;
  /** Provider owning authority uses precisely this frozen command selection. */
  dispatch(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    clientMsgId: string,
  ): Promise<void>;
}
type Store = Pick<
  EventStore,
  'admitOrdinaryLocalCommand' | 'claimOrdinaryLocalCommandDispatch' | 'completeOrdinaryLocalCommand'
>;
type Meta = Parameters<Store['admitOrdinaryLocalCommand']>[0];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
class OrdinaryLocalCodexAdmissionError extends Error {}
function fail(reason: string): never {
  throw new OrdinaryLocalCodexAdmissionError(`Ordinary local Codex admission ${reason}`);
}

const contentDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Session metadata cannot introduce a second model, mode, agent or recipe tuple. */
function reconcileSessionMetadata(meta: Meta, request: OrdinaryLocalCodexCommandRequest): void {
  const chosen = request.selection;
  if (
    (meta.mode !== undefined && meta.mode !== chosen.permission.mode) ||
    (meta.selectedModel !== undefined && meta.selectedModel !== chosen.model) ||
    (meta.reasoningEffort !== undefined && meta.reasoningEffort !== chosen.thinking)
  )
    fail('metadata_selection_mismatch');
  meta.mode = chosen.permission.mode;
  meta.selectedModel = chosen.model;
  meta.reasoningEffort = chosen.thinking;
  const account = AccountBindingSchema.safeParse(meta.accountBinding);
  if (
    !account.success ||
    account.data.accountId !== request.runtime.account.accountId ||
    account.data.provider !== request.runtime.account.provider ||
    account.data.profileRevision !== request.runtime.account.profileRevision ||
    account.data.model !== chosen.model
  )
    fail('metadata_account_mismatch');
  meta.accountBinding = account.data;
  if (meta.agentProfile !== undefined) {
    const parsed = AgentLibraryVersionSchema.safeParse(meta.agentProfile);
    if (
      !parsed.success ||
      parsed.data.profileId !== chosen.agent.profileId ||
      parsed.data.revision !== chosen.agent.revision ||
      parsed.data.contentHash !== contentDigest(parsed.data.definition)
    )
      fail('metadata_agent_mismatch');
    const recipe = parsed.data.definition.contextRecipe;
    if (
      recipe
        ? chosen.context.source !== recipe.source ||
          chosen.context.revision !== contentDigest(recipe)
        : chosen.context.source !== 'none'
    )
      fail('metadata_recipe_mismatch');
    meta.agentProfile = parsed.data;
  }
  if (meta.agentContext !== undefined) {
    const parsed = AgentContextSnapshotSchema.safeParse(meta.agentContext);
    if (
      !parsed.success ||
      !meta.agentProfile ||
      parsed.data.sandbox !== undefined ||
      parsed.data.profileId !== chosen.agent.profileId ||
      parsed.data.revision !== chosen.agent.revision ||
      parsed.data.profileHash !== meta.agentProfile.contentHash ||
      parsed.data.source !== chosen.context.source ||
      parsed.data.recipeHash !== chosen.context.revision ||
      parsed.data.payloadHash !==
        contentDigest(
          parsed.data.provenance
            ? { context: parsed.data.context, provenance: parsed.data.provenance }
            : parsed.data.context,
        )
    )
      fail('metadata_context_mismatch');
    meta.agentContext = parsed.data;
  }
}

/** New-session first-command coordinator and exact-receipt retries only.
 * Existing conversations cannot enroll or admit a new command through this slice.
 * Bounded coordinator only: no startup, API, host probe or provider consumer.
 * A durable reserved intent precedes every resource effect; CAS uncertainty
 * precedes workspace creation too, because uncertain creation cannot be retried
 * as if nothing happened. Recovery is owned separately, never automatic replay. */
export class OrdinaryLocalCodexAdmissionCoordinator {
  constructor(
    private readonly dependencies: {
      enabled: boolean;
      store: Store;
      catalog: Pick<OrdinaryLocalCodexCapabilityCatalog, 'inventory' | 'resolve'>;
      declaration: ReturnType<OrdinaryLocalCodexTarget['admissionDeclaration']>;
      authority?: OrdinaryLocalCodexAdmissionAuthority;
      bootstrapAuthority?: OrdinaryLocalCodexBootstrapAuthority;
    },
  ) {
    this.dependencies = {
      enabled: dependencies.enabled,
      declaration: structuredClone(dependencies.declaration),
      catalog: {
        inventory: dependencies.catalog.inventory.bind(dependencies.catalog),
        resolve: dependencies.catalog.resolve.bind(dependencies.catalog),
      },
      authority: dependencies.authority
        ? {
            withAdmission: dependencies.authority.withAdmission.bind(dependencies.authority),
          }
        : undefined,
      bootstrapAuthority: dependencies.bootstrapAuthority
        ? {
            withBootstrap: dependencies.bootstrapAuthority.withBootstrap.bind(
              dependencies.bootstrapAuthority,
            ),
          }
        : undefined,
      store: {
        admitOrdinaryLocalCommand: dependencies.store.admitOrdinaryLocalCommand.bind(
          dependencies.store,
        ),
        claimOrdinaryLocalCommandDispatch:
          dependencies.store.claimOrdinaryLocalCommandDispatch.bind(dependencies.store),
        completeOrdinaryLocalCommand: dependencies.store.completeOrdinaryLocalCommand.bind(
          dependencies.store,
        ),
      },
    };
  }

  async admit(
    meta: Meta,
    input: unknown,
    effects: OrdinaryLocalCodexAdmissionEffects,
  ): Promise<{ dispatched: boolean }> {
    const d = this.dependencies;
    if (!d.enabled || (!d.authority && !d.bootstrapAuthority)) fail('unavailable');
    if (d.authority && d.bootstrapAuthority) fail('authority_ambiguous');
    const parsed = Request.safeParse(input);
    if (!parsed.success) fail('invalid_request');
    const request = structuredClone(parsed.data);
    const admittedMeta = structuredClone(meta);
    if (!admittedMeta.repositoryWorkspaceId || !admittedMeta.cwd) fail('workspace_unavailable');
    if (request.selection.permission.mode !== request.runtime.mode) fail('permission_mismatch');
    assertNativeCodexContextAdmission(request.selection.context, admittedMeta.agentContext);
    reconcileSessionMetadata(admittedMeta, request);
    const inventory = structuredClone(d.catalog.inventory());
    if (inventory.capabilityRevision !== request.capabilityRevision) fail('capability_changed');
    const resolution = structuredClone(d.catalog.resolve(request.runtime));
    if (resolution.status !== 'compatible') fail('configuration_unavailable');
    const binding = resolution.binding;
    if (
      binding.account.provider !== 'openai-codex' ||
      binding.harness.implementation !== 'codex' ||
      binding.execution.location !== 'local' ||
      binding.execution.targetId !== d.declaration.targetId ||
      binding.execution.targetRevision !== d.declaration.targetRevision
    )
      fail('runtime_mismatch');
    const account = inventory.accounts.find(
      (candidate) =>
        candidate.account.accountId === binding.account.accountId &&
        candidate.account.profileRevision === binding.account.profileRevision,
    );
    const model = account?.models.find((candidate) => candidate.id === request.selection.model);
    if (!account || account.modelDiscovery.stale || !model) fail('model_unavailable');
    if (
      request.selection.thinking === null
        ? !!model.reasoningEfforts?.length
        : !model.reasoningEfforts?.includes(request.selection.thinking)
    )
      fail('thinking_unavailable');
    const expected: OrdinaryLocalCodexAdmissionExpectation = {
      binding,
      hostId: d.declaration.hostId,
      runtimeContractRevision: d.declaration.runtimeContractRevision,
      capabilityRevision: request.capabilityRevision,
      workspace: { workspaceId: admittedMeta.repositoryWorkspaceId, cwd: admittedMeta.cwd },
      selection: request.selection,
      agentProfile: admittedMeta.agentProfile,
      agentContext: admittedMeta.agentContext,
    };
    // Clone every boundary so an asynchronous owner cannot rewrite admitted input.
    const snapshot = structuredClone(expected);
    const prepareWorkspace = effects.prepareWorkspace.bind(effects);
    const dispatch = effects.dispatch.bind(effects);
    let entered = false;
    let claimed = false;
    let claimAttempted = false;
    const claim = () => {
      if (claimAttempted) fail('authority_reentry');
      claimAttempted = true;
      const fingerprint = `ordinary-local-codex-v1:${createHash('sha256')
        .update(
          JSON.stringify(
            canonical({
              request,
              workspace: snapshot.workspace,
              agentProfile: snapshot.agentProfile,
              agentContext: snapshot.agentContext,
            }),
          ),
        )
        .digest('hex')}`;
      try {
        d.store.admitOrdinaryLocalCommand(
          structuredClone(admittedMeta),
          structuredClone(snapshot.binding),
          {
            clientMsgId: request.clientMsgId,
            requestFingerprint: fingerprint,
            selection: structuredClone(snapshot.selection),
            payload: structuredClone(request.payload),
          },
        );
      } catch {
        fail('identity_conflict');
      }
      claimed = d.store.claimOrdinaryLocalCommandDispatch(request.clientMsgId);
      return claimed;
    };
    try {
      const operation = async (lease: OrdinaryLocalCodexAdmissionLease) => {
        if (!lease || typeof lease.assertCurrent !== 'function') fail('authority_unavailable');
        if (d.bootstrapAuthority && !claimed) fail('authority_unavailable');
        if (entered) fail('authority_reentry');
        entered = true;
        try {
          await lease.assertCurrent();
        } catch {
          fail(claimed ? 'dispatch_uncertain' : 'authority_unavailable');
        }
        if (!d.bootstrapAuthority && !claim()) return { dispatched: false };
        try {
          await lease.assertCurrent();
          await prepareWorkspace(structuredClone(snapshot));
          await lease.assertCurrent();
          await dispatch(structuredClone(snapshot), request.clientMsgId);
          d.store.completeOrdinaryLocalCommand(request.clientMsgId);
        } catch {
          fail('dispatch_uncertain');
        }
        return { dispatched: true };
      };
      const result = d.bootstrapAuthority
        ? await d.bootstrapAuthority.withBootstrap(structuredClone(snapshot), claim, operation)
        : await d.authority!.withAdmission(structuredClone(snapshot), operation);
      if (d.bootstrapAuthority && claimAttempted && !claimed && !entered && result === undefined)
        return { dispatched: false };
      if (!entered) fail('authority_unavailable');
      if (!result) fail(claimed ? 'dispatch_uncertain' : 'authority_unavailable');
      return result;
    } catch (error) {
      if (error instanceof OrdinaryLocalCodexAdmissionError) throw error;
      fail(claimed ? 'dispatch_uncertain' : 'authority_unavailable');
    }
  }
}
