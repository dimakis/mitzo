import { ConnectionStore, type Connection } from './connections-store.js';
import type { ConnectionGateway } from './connections-gateway.js';

/** Serializes lifecycle effects per connection; persisted state remains the recovery source after a restart. */
export class ConnectionsService {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly store: ConnectionStore,
    private readonly gateway: ConnectionGateway,
  ) {}
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => next);
    this.locks.set(id, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }
  async provision(connection: Connection, token: string, signal: AbortSignal) {
    return this.serial(connection.id, async () => {
      const current = this.store.get(connection.id);
      if (!current || current.status === 'revoking' || current.status === 'revoked')
        throw new Error('Connection cannot be provisioned');
      try {
        const provider = current.gatewayProviderId
          ? await this.gateway.get(current.gatewayProviderName, signal)
          : await this.gateway.provision({ name: current.gatewayProviderName, token }, signal);
        if (!provider) throw new Error('Managed provider is unavailable');
        const persisted = current.gatewayProviderId
          ? current
          : this.store.transition(
              current.id,
              current.revision,
              { gatewayProviderId: provider.id },
              { operation: 'provision', outcome: 'provider_created', actor: current.ownerId },
            );
        const identity = await this.gateway.probe(
          { providerName: persisted.gatewayProviderName, email: persisted.submittedEmail },
          signal,
        );
        return this.store.transition(
          persisted.id,
          persisted.revision,
          {
            status: 'active',
            gatewayProviderId: provider.id,
            identity: identity.identity,
            verifiedAt: Date.now(),
            errorCode: null,
          },
          { operation: 'provision', outcome: 'success', actor: current.ownerId },
        );
      } catch {
        const fresh = this.store.get(connection.id)!;
        this.store.transition(
          fresh.id,
          fresh.revision,
          { status: 'needs_attention', errorCode: 'PROVISION_FAILED' },
          { operation: 'provision', outcome: 'failed', actor: fresh.ownerId },
        );
        throw new Error('Connection provisioning failed');
      }
    });
  }
  async revoke(id: string, revision: number, actor: string, signal: AbortSignal) {
    return this.serial(id, async () => {
      const current = this.store.get(id);
      if (!current) throw new Error('Connection not found');
      const revoking =
        current.status === 'revoking'
          ? current
          : this.store.transition(
              id,
              revision,
              { status: 'revoking', desiredAccountIds: [] },
              { operation: 'revoke', outcome: 'started', actor },
            );
      try {
        const attached = await this.gateway.attachments(revoking.gatewayProviderName, signal);
        for (const sandbox of attached) {
          await this.gateway.stopSandbox(sandbox, signal);
          if (!(await this.gateway.sandboxStopped(sandbox, signal)))
            throw new Error('Sandbox did not stop');
          await this.gateway.detach(sandbox, revoking.gatewayProviderName, signal);
        }
        if ((await this.gateway.attachments(revoking.gatewayProviderName, signal)).length)
          throw new Error('Provider remains attached');
        await this.gateway.delete(revoking.gatewayProviderName, signal);
        return this.store.transition(
          id,
          revoking.revision,
          { status: 'revoked', errorCode: null },
          { operation: 'revoke', outcome: 'success', actor },
        );
      } catch {
        const fresh = this.store.get(id)!;
        this.store.transition(
          id,
          fresh.revision,
          { status: 'revoking', errorCode: 'REVOKE_PENDING' },
          { operation: 'revoke', outcome: 'pending', actor },
        );
        throw new Error('Connection revocation pending');
      }
    });
  }
  async reconcile(signal: AbortSignal) {
    for (const connection of this.store.incomplete()) {
      if (connection.status === 'revoking') {
        try {
          await this.revoke(connection.id, connection.revision, connection.ownerId, signal);
        } catch {
          /* durable retry next startup */
        }
      } else {
        this.store.transition(
          connection.id,
          connection.revision,
          { status: 'needs_attention', errorCode: 'RESUBMIT_REQUIRED' },
          { operation: 'reconcile', outcome: 'needs_attention', actor: connection.ownerId },
        );
      }
    }
  }
}
