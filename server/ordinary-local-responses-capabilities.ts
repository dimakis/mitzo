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
  resolveNewOrdinarySessionRuntime,
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
export const ordinaryLocalResponsesContractRevision = (
  harness: 'responses' | 'gemini' = 'responses',
) =>
  digest([
    `ordinary-local-${harness}-v1`,
    Object.entries(reviewedHandlerSourceArtifacts).sort(([a], [b]) => a.localeCompare(b)),
  ]);
/** Explicit private operator declaration; no environment/default inferred from credentials. */
export class OrdinaryLocalResponsesTarget {
  readonly #configuration;
  constructor(
    private readonly env: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly harness: 'responses' | 'gemini' = 'responses',
  ) {
    this.env = { ...env };
    this.#configuration = Configuration.parse(readPrivateRuntimeSettings(this.targetFile()));
    this.assertCurrentSync();
    registerWorkspaceRuntimeAuthorityPaths([this.targetFile()!], [this.targetFile()!]);
  }
  private targetFile() {
    return this.harness === 'gemini'
      ? this.env.MITZO_ORDINARY_LOCAL_GEMINI_TARGET_FILE
      : this.env.MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE;
  }
  assertCurrentSync() {
    const current = Configuration.parse(readPrivateRuntimeSettings(this.targetFile()));
    if (
      JSON.stringify(current) !== JSON.stringify(this.#configuration) ||
      current.hostId !== hostname() ||
      current.runtimeContractRevision !== ordinaryLocalResponsesContractRevision(this.harness)
    )
      throw Error('Local Responses target unavailable');
  }
  descriptor() {
    const c = this.#configuration;
    return {
      targetId: c.targetId,
      targetRevision: digest([`ordinary-local-${this.harness}-target-v1`, c]),
      label: c.label,
      location: 'local' as const,
      harness: this.harness,
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
function responsesCapabilities(
  profiles: AccountProfiles,
  target: OrdinaryLocalResponsesTarget,
  newWork: boolean,
) {
  const accounts =
    target.harness === 'gemini'
      ? profiles.ordinaryLocalGeminiInventory()
      : profiles.ordinaryLocalResponsesInventory();
  const targets = [target.descriptor()];
  const catalog: OrdinarySessionRuntimeCatalog = {
    deployment: 'ordinary',
    enabledHarnesses: [target.harness],
    accounts: accounts.map(({ account }) =>
      account.provider === 'google-vertex'
        ? { ...account, auth: { kind: 'vertex-adc' as const } }
        : { ...account, auth: { kind: 'api-credential' as const, openshellTargetIds: [] } },
    ),
    targets: targets.map(({ targetId, targetRevision, location }) => ({
      targetId,
      targetRevision,
      location,
    })),
  };
  const resolve = (request: unknown) =>
    target.harness === 'responses'
      ? { status: 'rejected' as const, code: 'new_work_harness_unsupported' as const }
      : (newWork ? resolveNewOrdinarySessionRuntime : resolveOrdinarySessionRuntime)(request, catalog);
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
      harness: target.harness,
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
  if (target.harness === 'responses') {
    inventory.routes = inventory.routes.filter(
      (route) =>
        resolve({
          account: route.account,
          targetId: route.targetId,
          harness: route.harness,
          mode: 'agent',
        }).status === 'compatible',
    );
    inventory.capabilityRevision = digest([
      'ordinary-local-retired-responses-capabilities-v1',
      newWork,
      inventory.capabilityRevision,
      inventory.routes,
    ]);
    if (!inventory.routes.length)
      inventory.locations = [
        { location: 'local', status: 'unavailable', reason: 'responses_execution_retired' },
      ];
  }
  return {
    inventory: () => structuredClone(inventory),
    resolve,
  };
}

/** Retained account/target metadata only. Responses execution is retired; the
 * same owner still serves executable deferred Gemini capability projection. */
export function localResponsesCapabilities(
  profiles: AccountProfiles,
  target: OrdinaryLocalResponsesTarget,
) {
  return responsesCapabilities(profiles, target, false);
}

/** Strict new-entry projection; retained histories keep their original engine.
 * Native Gemini replacement is deferred, so its existing route remains supported.
 */
export function newLocalResponsesCapabilities(
  profiles: AccountProfiles,
  target: OrdinaryLocalResponsesTarget,
) {
  return responsesCapabilities(profiles, target, true);
}
