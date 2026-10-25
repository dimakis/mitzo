import {
  ordinaryCodexAgentProfiles,
  ordinaryCodexAgentProfileRouteProjection,
} from './ordinary-codex-agent-profile.js';
import type { AgentLibraryVersion } from '@mitzo/protocol';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { SessionRuntimeBindingV1Schema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { retainLocalApiChatBinding } from './local-api-chat-continuity.js';
import type { AccountProfiles } from './account-profiles.js';
import { readPrivateRuntimeSettings } from './ordinary-local-codex-host-runtime.js';
import { reviewedHandlerSourceArtifacts } from './connections/reviewed-handler-artifacts.js';
import {
  resolveOrdinarySessionRuntime,
  type OrdinarySessionRuntimeCatalog,
} from './ordinary-session-runtime.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
const Configuration = z.strictObject({
  version: z.literal(1),
  targetId: reference,
  label: z.string().min(1).max(256),
  hostId: reference,
  runtimeContractRevision: reference,
});
export const ordinaryLocalVertexContractRevision = () =>
  digest([
    'ordinary-local-vertex-v1',
    Object.entries(reviewedHandlerSourceArtifacts).sort(([a], [b]) => a.localeCompare(b)),
  ]);
/** Explicit private operator declaration; no environment/default inferred from credentials. */
export class OrdinaryLocalVertexTarget {
  readonly #configuration;
  constructor(private readonly env: Readonly<NodeJS.ProcessEnv> = process.env) {
    this.env = { ...env };
    this.#configuration = Configuration.parse(
      readPrivateRuntimeSettings(this.env.MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE),
    );
    this.assertCurrentSync();
    registerWorkspaceRuntimeAuthorityPaths(
      [this.env.MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE!],
      [this.env.MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE!],
    );
  }
  assertCurrentSync() {
    const current = Configuration.parse(
      readPrivateRuntimeSettings(this.env.MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE),
    );
    if (
      JSON.stringify(current) !== JSON.stringify(this.#configuration) ||
      current.hostId !== hostname() ||
      current.runtimeContractRevision !== ordinaryLocalVertexContractRevision()
    )
      throw Error('Local Vertex target unavailable');
  }
  descriptor() {
    const c = this.#configuration;
    return {
      targetId: c.targetId,
      targetRevision: digest([
        'ordinary-local-vertex-target-v2',
        c.targetId,
        c.hostId,
        'claude-sdk-session-v1',
      ]),
      label: c.label,
      location: 'local' as const,
      harness: 'claude-sdk' as const,
    };
  }
  admissionDeclaration() {
    return {
      ...this.descriptor(),
      hostId: this.#configuration.hostId,
      runtimeContractRevision: this.#configuration.runtimeContractRevision,
    };
  }
}
export function localVertexCapabilities(
  profiles: AccountProfiles,
  target: OrdinaryLocalVertexTarget,
  published: readonly AgentLibraryVersion[] = [],
  retainedBinding?: unknown,
) {
  const accounts = profiles.ordinaryLocalVertexInventory();
  const eligibility = ordinaryCodexAgentProfileRouteProjection(
    ordinaryCodexAgentProfiles(published),
    'anthropic-vertex',
    'local',
    undefined,
    { contextRecipes: 'none' },
  );
  const targets = [target.descriptor()];
  const catalog: OrdinarySessionRuntimeCatalog = {
    deployment: 'ordinary',
    enabledHarnesses: ['claude-sdk'],
    accounts: accounts.map(({ account }) => ({
      ...account,
      auth: { kind: 'vertex-adc' },
    })),
    targets: targets.map(({ targetId, targetRevision, location }) => ({
      targetId,
      targetRevision,
      location,
    })),
  };
  const inventory = {
    version: 1 as const,
    authority: 'configuration-only' as const,
    defaultLocation: 'openshell' as const,
    capabilityRevision: digest([
      'ordinary-local-vertex-capabilities-v1',
      catalog,
      accounts,
      eligibility,
    ]),
    accounts,
    targets,
    routes: accounts.map(({ account }) => ({
      account,
      targetId: targets[0].targetId,
      harness: 'claude-sdk' as const,
      ...eligibility,
      modes: ['ask', 'agent', 'auto'] as const,
      skillCeiling: 'unsupported' as const,
    })),
    locations: [
      {
        location: 'local' as const,
        status: accounts.length ? ('configured' as const) : ('unavailable' as const),
        ...(accounts.length ? {} : { reason: 'accounts_unavailable' }),
      },
    ],
  };
  return {
    declaration: {
      ...target.admissionDeclaration(),
      ...(retainedBinding === undefined
        ? {}
        : {
            targetRevision:
              SessionRuntimeBindingV2Schema.parse(retainedBinding).execution.targetRevision,
          }),
    },
    inventory: () => structuredClone(inventory),
    resolve: (request: unknown) =>
      retainLocalApiChatBinding(resolveOrdinarySessionRuntime(request, catalog), retainedBinding),
  };
}
