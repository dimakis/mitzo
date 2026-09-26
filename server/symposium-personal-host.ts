import { AccountProfiles } from './account-profiles.js';
import { DeviceLoginCleanupError } from './symposium-device-login.js';
import { PersonalConnections, type ConnectionSelection } from './symposium-personal-connections.js';
import {
  createSymposiumSubscriptionHost,
  type SymposiumSubscriptionHostOptions,
} from './symposium-subscription-host.js';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';
/** Slots retain display metadata only; each live adapter owns an independent receipt. */
export function createPersonalSubscriptionHost(
  options: SymposiumSubscriptionHostOptions,
  metadataPath: string,
) {
  const initial = createSymposiumSubscriptionHost(options);
  const connections = new PersonalConnections(metadataPath, (accountId, label) =>
    accountId === options.accountId
      ? initial
      : createSymposiumSubscriptionHost({ ...options, accountId, label, workProfiles: [] }),
  );
  if (!connections.list().some((row) => row.id === options.accountId))
    connections.create(options.label, options.accountId);
  const select = (selection?: ConnectionSelection) => {
    const row = connections
      .list()
      .find((row) => row.id === (selection?.connectionId ?? options.accountId));
    if (!row || (selection && selection.expectedRevision !== row.revision))
      throw new Error('Connection changed; refresh before retry');
    return row;
  };
  const start = async (device: boolean, selection?: ConnectionSelection) => {
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
      list: () => connections.list(),
      create: (label: string) => connections.create(label),
      disconnect: (id: string, revision: number) => connections.disconnect(id, revision),
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
