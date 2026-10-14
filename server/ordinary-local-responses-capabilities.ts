import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { SessionRuntimeBindingV1Schema } from '@mitzo/protocol';
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
export const ordinaryLocalResponsesContractRevision = () =>
  digest([
    'ordinary-local-responses-v1',
    Object.entries(reviewedHandlerSourceArtifacts).sort(([a], [b]) => a.localeCompare(b)),
  ]);
/** Explicit private operator declaration; no environment/default inferred from credentials. */
export class OrdinaryLocalResponsesTarget {
  readonly #configuration;
  constructor(private readonly env: Readonly<NodeJS.ProcessEnv> = process.env) {
    this.env = { ...env };
    this.#configuration = Configuration.parse(
      readPrivateRuntimeSettings(this.env.MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE),
    );
    this.assertCurrentSync();
    registerWorkspaceRuntimeAuthorityPaths(
      [this.env.MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE!],
      [this.env.MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE!],
    );
  }
  assertCurrentSync() {
    const current = Configuration.parse(
      readPrivateRuntimeSettings(this.env.MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE),
    );
    if (
      JSON.stringify(current) !== JSON.stringify(this.#configuration) ||
      current.hostId !== hostname() ||
      current.runtimeContractRevision !== ordinaryLocalResponsesContractRevision()
    )
      throw Error('Local Responses target unavailable');
  }
  descriptor() {
    const c = this.#configuration;
    return {
      targetId: c.targetId,
      targetRevision: digest(['ordinary-local-responses-target-v1', c]),
      label: c.label,
      location: 'local' as const,
      harness: 'responses' as const,
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
export function localResponsesCapabilities(
  profiles: AccountProfiles,
  target: OrdinaryLocalResponsesTarget,
) {
  const accounts = profiles.ordinaryLocalResponsesInventory();
  const targets = [target.descriptor()];
  const catalog: OrdinarySessionRuntimeCatalog = {
    deployment: 'ordinary',
    enabledHarnesses: ['responses'],
    accounts: accounts.map(({ account }) => ({
      ...account,
      auth: { kind: 'api-credential', openshellTargetIds: [] },
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
    capabilityRevision: digest(['ordinary-local-responses-capabilities-v1', catalog, accounts]),
    accounts,
    targets,
    routes: accounts.map(({ account }) => ({
      account,
      targetId: targets[0].targetId,
      harness: 'responses' as const,
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
    inventory: () => structuredClone(inventory),
    resolve: (request: unknown) => resolveOrdinarySessionRuntime(request, catalog),
  };
}
