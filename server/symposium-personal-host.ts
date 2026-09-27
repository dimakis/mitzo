import type { CatalogModel } from './model-catalog.js';
import type { DiscoveryResult } from './symposium-model-discovery.js';
import { AccountProfiles } from './account-profiles.js';
import { DeviceLoginCleanupError } from './symposium-device-login.js';
import { PersonalConnections, type ConnectionSelection } from './symposium-personal-connections.js';
import {
  createSymposiumSubscriptionHost,
  type SymposiumSubscriptionHostOptions,
} from './symposium-subscription-host.js';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';
type DiscoveryRecovery = (assertCurrent: () => void) => Promise<DiscoveryResult>;
/** Slots retain display metadata only; each live adapter owns an independent receipt. */
export function createPersonalSubscriptionHost(
  options: SymposiumSubscriptionHostOptions,
  metadataPath: string,
  discover?: (proof: {
    provider: { name: string; id: string };
    account: { email: string; planType: string };
    assertCurrent(): void;
  }) => Promise<{ result: DiscoveryResult; models?: CatalogModel[]; recover?: DiscoveryRecovery }>,
) {
  const recoveries = new Map<string, { revision: number; recover: DiscoveryRecovery }>();
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
      return new AccountProfiles(
        [
          ...options.workProfiles,
          ...connections
            .activeAdapters()
            .flatMap((a) => (a.activeDefinition ? [a.activeDefinition] : [])),
        ],
        { codexEnabled: true },
      );
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
          const result = await retained!.recover(check);
          check();
          if (result.status !== 'reconciled')
            return {
              ...result,
              connection: select({ connectionId: id, expectedRevision: revision }),
            };
          const connection = connections.finishDiscoveryRecovery(id, revision);
          recoveries.delete(id);
          return { ...result, connection };
        } finally {
          recovering = false;
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
          discoveryEntered = true;
          const discovered = await discover({
            provider: proof.provider,
            account: proof.account,
            assertCurrent,
          });
          assertCurrent();
          if (discovered.result.status === 'complete') {
            if (!discovered.models?.length) throw new Error('Discovery catalog missing');
            proof.publish(discovered.models, lease.revision + 1);
          }
          // Retain cleanup authority before invalidation destroys admission authority.
          if (discovered.result.status === 'reconciliation_required' && discovered.recover)
            recoveries.set(id, { revision: lease.revision + 1, recover: discovered.recover });
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
