import type { SubscriptionLaunchIdentity } from './symposium-subscription-identity.js';
import type { CatalogModel } from './model-catalog.js';
import {
  RoutingDiagnosticResultSchema,
  assertDiscoveryNotDispatchedEvidence,
  type DiscoveryNotDispatchedEvidence,
  type DiscoveryConfig,
  type DiscoveryResult,
  type RoutingDiagnosticResult,
} from './symposium-model-discovery.js';
import { AccountProfiles } from './account-profiles.js';
import { DeviceLoginCleanupError } from './symposium-device-login.js';
import { PersonalConnections, type ConnectionSelection } from './symposium-personal-connections.js';
import {
  createSymposiumSubscriptionHost,
  type SymposiumSubscriptionHostOptions,
} from './symposium-subscription-host.js';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';
type DiscoveryRecovery = (assertCurrent: () => void) => Promise<DiscoveryResult>;
export interface PersonalRoutingDiagnosticOutcome {
  result: RoutingDiagnosticResult;
  recover?: DiscoveryRecovery;
  undispatched?: PersonalRoutingDiagnosticUndispatchedDisposition;
}
export interface PersonalDiscoveryProof {
  provider: { name: string; id: string };
  account: { email: string; planType: string };
  launchIdentity?(): SubscriptionLaunchIdentity;
  assertCurrent(): void;
}

export interface PersonalRoutingDiagnosticUndispatchedDisposition {
  readonly kind: 'owned-routing-undispatched';
}
const undispatchedOutcomes = new WeakMap<object, PersonalDiscoveryProof>();
/** Retained only inside one owned diagnostic callback, never restored from metadata. */
export function createPersonalRoutingDiagnosticDispatchWitness(proof: PersonalDiscoveryProof) {
  const origin = Object.freeze({});
  let disposition: PersonalRoutingDiagnosticUndispatchedDisposition | undefined;
  return {
    origin,
    confirm(config: DiscoveryConfig, evidence: DiscoveryNotDispatchedEvidence) {
      assertDiscoveryNotDispatchedEvidence(config, evidence, origin);
      if (
        disposition ||
        config.provider.name !== proof.provider.name ||
        config.provider.id !== proof.provider.id
      )
        throw new Error('Original diagnostic nondispatch evidence changed');
      disposition = Object.freeze({ kind: 'owned-routing-undispatched' });
      undispatchedOutcomes.set(disposition, proof);
    },
    disposition: () => disposition,
  };
}
const undispatchedPreflightFailures = new WeakMap<object, PersonalDiscoveryProof>();
/** Trusted owned-factory preparation only: this boundary must end before the runner
 * or any native allocation capability is invoked. Evidence belongs to one exact proof. */
export async function preparePersonalRoutingDiagnostic<T>(
  proof: PersonalDiscoveryProof,
  prepare: () => Promise<T>,
): Promise<T> {
  try {
    return await prepare();
  } catch {
    const error = new Error('Owned routing diagnostic preflight failed');
    undispatchedPreflightFailures.set(error, proof);
    throw error;
  }
}

/** Slots retain display metadata only; each live adapter owns an independent receipt. */
export function createPersonalSubscriptionHost(
  options: SymposiumSubscriptionHostOptions,
  metadataPath: string,
  discover?: (proof: PersonalDiscoveryProof) => Promise<{
    result: DiscoveryResult;
    models?: CatalogModel[];
    recover?: DiscoveryRecovery;
  }>,
  diagnose?: (proof: PersonalDiscoveryProof) => Promise<PersonalRoutingDiagnosticOutcome>,
) {
  const recoveries = new Map<
    string,
    {
      revision: number;
      recover: DiscoveryRecovery;
      cleanupCredentials(): Promise<void>;
      discoveryClean: boolean;
    }
  >();
  let recovering = false;
  const initial = createSymposiumSubscriptionHost(options);
  const connections = new PersonalConnections(metadataPath, (accountId, label) =>
    accountId === options.accountId
      ? initial
      : createSymposiumSubscriptionHost({ ...options, accountId, label, workProfiles: [] }),
  );
  if (!connections.list().some((row) => row.id === options.accountId))
    connections.create(options.label, options.accountId);
  const select = (selection?: ConnectionSelection) => {
    if (
      !selection ||
      typeof selection.connectionId !== 'string' ||
      !Number.isSafeInteger(selection.expectedRevision) ||
      selection.expectedRevision < 1
    )
      throw new Error('An explicit connection and current revision are required');
    const row = connections.list().find((row) => row.id === selection.connectionId);
    if (!row || selection.expectedRevision !== row.revision)
      throw new Error('Connection changed; refresh before retry');
    return row;
  };
  const assertNoDiscovery = () => {
    if (connections.list().some((row) => row.modelDiscovery))
      throw new Error('Model discovery must finish or be reconciled first');
  };
  const start = async (device: boolean, selection?: ConnectionSelection) => {
    assertNoDiscovery();
    let row = select(selection);
    if (row.state === 'connected') row = await connections.disconnect(row.id, row.revision);
    const lease = connections.begin(row.id, row.revision);
    try {
      const login = await (device ? lease.adapter.beginDeviceLogin() : lease.adapter.beginLogin());
      const completed = login.completed
        .then((result) => {
          const verified = result as { email: string; planType: 'free' | 'plus' | 'pro' };
          connections.complete(lease, {
            email: verified.email,
            planType: verified.planType.toLowerCase() as 'free' | 'plus' | 'pro',
          });
          return result;
        })
        .catch(async (error) => {
          let uncertain = error instanceof DeviceLoginCleanupError;
          try {
            await lease.adapter.disconnect();
          } catch {
            uncertain = true;
          }
          connections.fail(lease, uncertain);
          if (uncertain) throw new DeviceLoginCleanupError();
          throw new Error('Personal subscription login did not complete');
        });
      // Attach immediately: cancellation may reject before the HTTP controller resumes.
      void completed.catch(() => undefined);
      return {
        ...login,
        completed,
        async cancel() {
          await login.cancel();
          await completed.catch(() => undefined);
          const current = connections.list().find((r) => r.id === lease.id);
          if (current?.state === 'connected')
            await connections.disconnect(current.id, current.revision);
          if (current?.state === 'recovery_required') throw new DeviceLoginCleanupError();
        },
      };
    } catch (error) {
      let uncertain = error instanceof DeviceLoginCleanupError;
      try {
        await lease.adapter.disconnect();
      } catch {
        uncertain = true;
      }
      connections.fail(lease, uncertain);
      if (uncertain) throw new DeviceLoginCleanupError();
      throw error;
    }
  };
  const adapter = (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) =>
    connections.adapter(input.execution.seat.accountBinding?.accountId ?? '');
  return {
    captureAdmissionProvider(selection: ConnectionSelection) {
      options.gateway.verifyCustody();
      assertNoDiscovery();
      const row = select(selection);
      if (row.state !== 'connected') throw new Error('Connected personal slot required');
      const captured = connections.adapter(row.id);
      const proof = captured.captureDiscovery();
      const assertCurrent = () => {
        options.gateway.verifyCustody();
        assertNoDiscovery();
        const current = select(selection);
        if (current.state !== 'connected' || connections.adapter(current.id) !== captured)
          throw new Error('Personal slot changed');
        proof.assertCurrent();
      };
      assertCurrent();
      return {
        provider: { ...proof.provider, type: 'codex' as const, profileName: 'codex' as const },
        assertCurrent,
      };
    },
    get currentProfiles() {
      options.gateway.verifyCustody();
      // Capture provenance from the registry that owns each exact adapter. The
      // catalog and lifecycle reads may settle at different revisions; consumers
      // must compare this snapshot before presenting them as one account.
      const links = new Map<string, { id: string; revision: number }>();
      const personal = connections.list().flatMap((row) => {
        if (row.state !== 'connected') return [];
        const definition = connections.adapter(row.id).activeDefinition;
        if (!definition) return [];
        if (typeof definition !== 'object' || !('id' in definition) || definition.id !== row.id)
          throw new Error('Personal catalog binding changed');
        links.set(row.id, { id: row.id, revision: row.revision });
        return [definition];
      });
      return new AccountProfiles([...options.workProfiles, ...personal], {
        codexEnabled: true,
        personalConnectionLinks: links,
      });
    },
    personalConnections: {
      list: () =>
        connections.list().map((row) => ({
          ...row,
          ...(row.state === 'recovery_required' &&
          row.modelDiscovery === 'reconciliation_required' &&
          recoveries.get(row.id)?.revision === row.revision
            ? { discoveryRecoveryAvailable: true }
            : {}),
        })),
      create: (label: string) => {
        assertNoDiscovery();
        return connections.create(label);
      },
      disconnect: async (id: string, revision: number) => {
        assertNoDiscovery();
        return connections.disconnect(id, revision);
      },
      async recoverDiscovery(id: string, revision: number, assertOperator: () => void) {
        const retained = recoveries.get(id);
        const check = () => {
          assertOperator();
          options.gateway.verifyCustody();
          const row = select({ connectionId: id, expectedRevision: revision });
          if (
            row.state !== 'recovery_required' ||
            row.modelDiscovery !== 'reconciliation_required' ||
            !retained ||
            retained.revision !== revision ||
            recoveries.get(id) !== retained
          )
            throw new Error('Retained discovery recovery is unavailable');
        };
        check();
        if (recovering) throw new Error('Discovery recovery is already running');
        recovering = true;
        try {
          const result = retained!.discoveryClean
            ? { status: 'reconciled' as const, inference: false as const }
            : await retained!.recover(check);
          // Keep exact successful cleanup evidence even if operator authority
          // expires before the next check. It grants no credential/login authority.
          if (result.status === 'reconciled') retained!.discoveryClean = true;
          check();
          if (result.status !== 'reconciled')
            return {
              ...result,
              connection: select({ connectionId: id, expectedRevision: revision }),
            };
          // The retained adapter serializes cleanup through the workspace fence
          // and rejects any remaining sandbox before deleting credential resources.
          await retained!.cleanupCredentials();
          check();
          const connection = connections.finishDiscoveryRecovery(id, revision);
          recoveries.delete(id);
          return { ...result, connection };
        } finally {
          recovering = false;
        }
      },
      /** Trusted optional native capability only. This never invalidates, publishes
       * or implies a supported model catalog; the lease only fences owned work. */
      async diagnoseRouting(id: string, revision: number, assertOperator: () => void) {
        assertOperator();
        if (!diagnose) throw new Error('Owned routing diagnostic is unavailable');
        assertNoDiscovery();
        if (connections.list().some((row) => ['connecting', 'disconnecting'].includes(row.state)))
          throw new Error('Account change is pending');
        const lease = connections.beginDiscovery(id, revision);
        let entered = false;
        let diagnosticProof: PersonalDiscoveryProof | undefined;
        let cleanUndispatchedOutcome = false;
        try {
          options.gateway.verifyCustody();
          const proof = lease.adapter.captureDiscovery();
          const assertCurrent = () => {
            assertOperator();
            options.gateway.verifyCustody();
            connections.assertDiscovery(lease);
            proof.assertCurrent();
          };
          assertCurrent();
          if (proof.account.planType !== 'pro')
            throw new Error('A live Personal Pro receipt is required');
          entered = true;
          diagnosticProof = {
            provider: proof.provider,
            account: proof.account,
            launchIdentity: () => {
              assertCurrent();
              const identity = proof.launchIdentity();
              return {
                accountId: identity.accountId,
                assertCurrent: () => {
                  assertCurrent();
                  identity.assertCurrent();
                },
              };
            },
            assertCurrent,
          };
          const rawResult = await diagnose(diagnosticProof);
          const result = RoutingDiagnosticResultSchema.parse(rawResult.result);
          if (rawResult.undispatched !== undefined) {
            if (
              result.status !== 'failed' ||
              rawResult.recover !== undefined ||
              undispatchedOutcomes.get(rawResult.undispatched) !== diagnosticProof
            )
              throw new Error('Invalid original diagnostic nondispatch disposition');
            cleanUndispatchedOutcome = true;
          }
          // The same-process cleanup closure is retained before admission
          // invalidation, including a late operator revocation after return.
          if (rawResult.recover) {
            if (typeof rawResult.recover !== 'function')
              throw new Error('Invalid diagnostic recovery');
            recoveries.set(id, {
              revision: lease.revision + 1,
              recover: rawResult.recover,
              cleanupCredentials: () => lease.adapter.disconnect(),
              discoveryClean: false,
            });
          }
          assertCurrent();
          const connection = connections.finishDiscovery(
            lease,
            result.status !== 'reconciliation_required',
          );
          if (result.status !== 'reconciliation_required') recoveries.delete(id);
          return { ...result, connection };
        } catch (error) {
          const undispatched =
            cleanUndispatchedOutcome ||
            !entered ||
            (!!diagnosticProof &&
              typeof error === 'object' &&
              error !== null &&
              undispatchedPreflightFailures.get(error) === diagnosticProof);
          let released = false;
          try {
            connections.finishDiscovery(lease, undispatched);
            released = undispatched;
          } catch {
            /* Preserve unresolved owned operation. */
          }
          // eslint-disable-next-line preserve-caught-error -- Public errors omit private native/configuration details.
          throw new Error(
            released
              ? 'Personal routing diagnostic preflight failed'
              : 'Personal routing diagnostic requires recovery',
          );
        }
      },
      async discoverModels(id: string, revision: number, assertOperator: () => void) {
        assertOperator();
        if (!discover) throw new Error('Owned model discovery is unavailable');
        assertNoDiscovery();
        if (connections.list().some((row) => ['connecting', 'disconnecting'].includes(row.state)))
          throw new Error('Account change is pending');
        const lease = connections.beginDiscovery(id, revision);
        let discoveryEntered = false;
        try {
          const proof = lease.adapter.captureDiscovery();
          const assertCurrent = () => {
            assertOperator();
            connections.assertDiscovery(lease);
            proof.assertCurrent();
          };
          assertCurrent();
          // A prior successful catalog must not remain fresh after a failed refresh.
          proof.invalidateCatalog();
          discoveryEntered = true;
          const discovered = await discover({
            provider: proof.provider,
            account: proof.account,
            launchIdentity: () => {
              assertCurrent();
              const identity = proof.launchIdentity();
              return {
                accountId: identity.accountId,
                assertCurrent: () => {
                  assertCurrent();
                  identity.assertCurrent();
                },
              };
            },
            assertCurrent,
          });
          assertCurrent();
          if (discovered.result.status === 'complete') {
            if (!discovered.models?.length) throw new Error('Discovery catalog missing');
            proof.publish(discovered.models, lease.revision + 1);
          }
          // Retain cleanup authority before invalidation destroys admission authority.
          if (discovered.result.status === 'reconciliation_required' && discovered.recover)
            recoveries.set(id, {
              revision: lease.revision + 1,
              recover: discovered.recover,
              cleanupCredentials: () => lease.adapter.disconnect(),
              discoveryClean: false,
            });
          const connection = connections.finishDiscovery(
            lease,
            discovered.result.status !== 'reconciliation_required',
          );
          return {
            ...discovered.result,
            connection,
            ...(discovered.result.status === 'complete' ? { models: discovered.models } : {}),
          };
        } catch {
          let locallyReleased = false;
          try {
            // Before entering the discovery capability, only this local marker exists.
            // Once entered, an exception cannot prove remote allocation was absent.
            connections.finishDiscovery(lease, !discoveryEntered);
            locallyReleased = !discoveryEntered;
          } catch {
            /* retained recovery state */
          }
          throw new Error(
            locallyReleased
              ? 'Personal model discovery preflight failed'
              : 'Personal model discovery requires recovery',
          );
        }
      },
    },
    invalidate: () => connections.invalidate(),
    captureLaunchIdentity: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) =>
      adapter(input).captureLaunchIdentity(input),
    verifyPrivateAuth: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) =>
      adapter(input).verifyPrivateAuth(input),
    assertPrivateAuth: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) =>
      adapter(input).assertPrivateAuth(input),
    beginDeviceLogin: (selection?: ConnectionSelection) =>
      start(true, selection) as ReturnType<
        ReturnType<typeof createSymposiumSubscriptionHost>['beginDeviceLogin']
      >,
    beginLogin: (selection?: ConnectionSelection) =>
      start(false, selection) as ReturnType<
        ReturnType<typeof createSymposiumSubscriptionHost>['beginLogin']
      >,
  };
}
