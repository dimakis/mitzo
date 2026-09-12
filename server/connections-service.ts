import { ConnectionStore, RevisionConflictError, type Connection } from './connections-store.js';
import { randomUUID } from 'node:crypto';
import {
  JIRA_TEMPLATE_ID,
  type ConnectionGateway,
  type GatewayProvider,
} from './connections-gateway.js';

type CreateInput = Parameters<ConnectionStore['create']>[0];
/** One control-plane gate orders runtime creation against consent/credential changes.
 * Durable intent is written before gateway effects, so restart can complete cleanup. */
export class ConnectionsService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: ConnectionStore,
    private readonly gateway: ConnectionGateway,
    private readonly options: {
      gateway?: string;
      workspace?: string;
      eligibleAccountIds?: () => string[];
    } = {},
  ) {}
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      release();
    }
  }
  catalog(ownerId = 'operator') {
    return this.store.list(ownerId);
  }
  resolveForAccount(accountId: string, ownerId = 'operator') {
    return (
      this.catalog(ownerId).find(
        (c) =>
          c.status === 'active' &&
          c.verifiedAt !== null &&
          c.gatewayProviderId &&
          c.desiredAccountIds.includes(accountId),
      ) ?? null
    );
  }
  private current(id: string, revision?: number) {
    const c = this.store.get(id);
    if (!c || c.ownerId !== 'operator') throw new Error('Connection not found');
    if (revision !== undefined && c.revision !== revision) throw new RevisionConflictError();
    if (
      c.gateway !== (this.options.gateway ?? 'openshell') ||
      c.workspace !== (this.options.workspace ?? 'default')
    )
      throw new Error('Connection gateway binding changed');
    return c;
  }
  private change(
    c: Connection,
    changes: Parameters<ConnectionStore['transition']>[2],
    operation: string,
    outcome: string,
  ) {
    return this.store.transition(c.id, c.revision, changes, {
      operation,
      outcome,
      actor: c.ownerId,
    });
  }
  private validateAccounts(ids: string[]) {
    if (
      new Set(ids).size !== ids.length ||
      (this.options.eligibleAccountIds &&
        ids.some((id) => !this.options.eligibleAccountIds!().includes(id)))
    )
      throw new Error('Account is not eligible');
  }
  private checkProvider(c: Connection, p: GatewayProvider) {
    if (
      p.name !== c.gatewayProviderName ||
      p.workspace !== c.workspace ||
      p.type !== JIRA_TEMPLATE_ID ||
      (c.gatewayProviderId && p.id !== c.gatewayProviderId) ||
      !p.credentialKeys.includes('JIRA_API_TOKEN')
    )
      throw new Error('Managed provider binding changed');
  }
  private async boundProvider(c: Connection, signal: AbortSignal, allowMissing = false) {
    this.current(c.id);
    const p = await this.gateway.get(c.gatewayProviderName, signal);
    if (!p) {
      if (allowMissing) return undefined;
      throw new Error('Managed provider unavailable');
    }
    this.checkProvider(c, p);
    return p;
  }
  async withAccountRuntime<T>(
    accountId: string,
    work: (connection: Connection | null) => Promise<T>,
    signal = AbortSignal.timeout(120_000),
  ) {
    return this.serial(async () => {
      signal.throwIfAborted();
      const c = this.resolveForAccount(accountId);
      if (c) await this.boundProvider(c, signal);
      return work(c);
    });
  }
  /** Called inside withAccountRuntime before ensure. Existing sessions cannot gain new grants. */
  async verifyRuntimeSandbox(name: string, connection: Connection | null, signal: AbortSignal) {
    const sandbox = await this.gateway.sandbox(name, signal);
    if (!sandbox) return;
    const providers = await this.gateway.sandboxProviders(name, signal);
    const managed = providers.filter((p) => p.startsWith('mitzo-conn-'));
    const expected = connection ? [connection.gatewayProviderName] : [];
    if (managed.length !== expected.length || managed.some((p) => !expected.includes(p)))
      throw new Error('Connection permissions changed. Start a new conversation.');
  }
  private async drain(c: Connection, signal: AbortSignal, removedAccounts?: string[]) {
    const p = await this.boundProvider(c, signal, true);
    if (!p) return;
    for (const name of await this.gateway.attachments(c.gatewayProviderName, signal)) {
      if (removedAccounts) {
        const info = await this.gateway.sandbox(name, signal);
        const account = info?.labels?.['mitzo.connection_account'];
        if (account && !removedAccounts.includes(account)) continue;
      }
      await this.gateway.stopSandbox(name, signal);
      if (!(await this.gateway.sandboxStopped(name, signal)))
        throw new Error('Sandbox shutdown pending');
      await this.gateway.detach(name, c.gatewayProviderName, signal);
    }
    if (!removedAccounts && (await this.gateway.attachments(c.gatewayProviderName, signal)).length)
      throw new Error('Provider remains attached');
  }
  async setAssignments(
    id: string,
    revision: number,
    accountIds: string[],
    actor = 'operator',
    signal = AbortSignal.timeout(120_000),
  ) {
    return this.serial(async () => {
      const c = this.current(id, revision);
      this.validateAccounts(accountIds);
      const existing = this.store.pendingAssignments().find((x) => x.connectionId === id);
      if (actor !== c.ownerId || (c.status !== 'active' && !existing))
        throw new Error('Connection is not active');
      if (existing && JSON.stringify(existing.accountIds) !== JSON.stringify(accountIds))
        throw new Error('Previous assignment removal must finish first');
      const removed =
        existing?.removedIds ?? c.desiredAccountIds.filter((id) => !accountIds.includes(id));
      if (removed.length) {
        const pending = existing ? c : this.store.startAssignment(c, accountIds, removed);
        await this.completeAssignment(pending, accountIds, removed, signal);
        return this.current(id);
      }
      return this.store.setAssignments(id, revision, accountIds, actor);
    });
  }
  private async completeAssignment(
    c: Connection,
    accountIds: string[],
    removed: string[],
    signal: AbortSignal,
  ) {
    await this.drain(c, signal, removed);
    this.validateAccounts(accountIds);
    const updated = this.store.setAssignments(c.id, c.revision, accountIds, c.ownerId);
    this.change(updated, { status: 'active', errorCode: null }, 'assign', 'success');
    this.store.finishAssignment(c.id);
  }
  async createAndProvision(input: CreateInput, token: string, signal: AbortSignal) {
    this.validateAccounts(input.desiredAccountIds);
    const c = this.store.create(input);
    return this.provision(c, token, signal);
  }
  private async runProbe(c: Connection, signal: AbortSignal) {
    const sandboxName = `mitzo-probe-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const op = this.store.startProbe(c, sandboxName);
    let result: { identity: string } | undefined;
    try {
      result = await this.gateway.probe(
        { providerName: c.gatewayProviderName, email: c.submittedEmail, sandboxName },
        signal,
      );
    } catch {
      /* Cleanup still runs independently of probe failure or cancellation. */
    }
    try {
      await this.gateway.deleteSandbox(sandboxName, AbortSignal.timeout(30_000));
      this.store.finishProbe(op.id);
    } catch {
      this.store.probeCleanupPending(op.id);
      throw new Error('Probe cleanup pending');
    }
    if (!result) throw new Error('Gateway identity probe failed');
    return result;
  }

  async retry(id: string, revision: number, token: string, signal: AbortSignal) {
    return this.provision(this.current(id, revision), token, signal);
  }
  private async cleanupConnection(c: Connection) {
    for (const op of this.store.pendingProbes().filter((x) => x.connectionId === c.id)) {
      try {
        await this.gateway.deleteSandbox(op.sandboxName, AbortSignal.timeout(30_000));
        this.store.finishProbe(op.id);
      } catch {
        this.store.probeCleanupPending(op.id);
        throw new Error('Probe cleanup pending');
      }
    }
    for (const op of this.store.candidates().filter((x) => x.connectionId === c.id)) {
      const candidate = { ...c, gatewayProviderName: op.name, gatewayProviderId: op.providerId };
      const p = await this.gateway.get(op.name, AbortSignal.timeout(30_000));
      if (p) {
        this.checkProvider(candidate, p);
        await this.gateway.delete(op.name, AbortSignal.timeout(30_000));
      }
      this.store.finishCandidate(op.name);
    }
  }
  async provision(connection: Connection, token: string, signal: AbortSignal) {
    return this.serial(async () => {
      let c = this.current(connection.id, connection.revision);
      if (
        !['provisioning', 'needs_attention'].includes(c.status) ||
        c.identity ||
        this.store.pendingAssignments().some((x) => x.connectionId === c.id)
      )
        throw new Error('Connection cannot be provisioned');
      try {
        await this.cleanupConnection(c);
        await this.gateway.verifyCompatibility(signal);
        let p = await this.gateway.get(c.gatewayProviderName, signal);
        if (p) {
          this.checkProvider(c, p);
          // The generated durable name recovers a create whose response was lost.
          if (!c.gatewayProviderId)
            c = this.change(c, { gatewayProviderId: p.id }, 'provision', 'provider_recovered');
          await this.gateway.rotate({ name: c.gatewayProviderName, token }, signal);
        } else {
          if (c.gatewayProviderId) throw new Error('Managed provider unavailable');
          p = await this.gateway.provision({ name: c.gatewayProviderName, token }, signal);
          this.checkProvider(c, p);
          c = this.change(c, { gatewayProviderId: p.id }, 'provision', 'provider_created');
        }
        const identity = await this.runProbe(c, signal);
        this.validateAccounts(c.desiredAccountIds);
        return this.change(
          c,
          {
            status: 'active',
            identity: identity.identity,
            verifiedAt: Date.now(),
            errorCode: null,
          },
          'provision',
          'success',
        );
      } catch {
        this.change(
          this.current(c.id),
          { status: 'needs_attention', errorCode: 'PROVISION_FAILED' },
          'provision',
          'failed',
        );
        throw new Error('Connection provisioning failed');
      }
    });
  }
  async test(id: string, revision: number, signal: AbortSignal) {
    return this.serial(async () => {
      const c = this.current(id, revision);
      if (
        !['active', 'needs_attention'].includes(c.status) ||
        this.store.pendingAssignments().some((x) => x.connectionId === id)
      )
        throw new Error('Connection cannot be tested');
      try {
        await this.cleanupConnection(c);
        await this.gateway.verifyCompatibility(signal);
        await this.boundProvider(c, signal);
        const result = await this.runProbe(c, signal);
        if (c.identity && c.identity !== result.identity) throw new Error('Jira identity changed');
        return this.change(
          c,
          { status: 'active', identity: result.identity, verifiedAt: Date.now(), errorCode: null },
          'test',
          'success',
        );
      } catch {
        this.change(
          this.current(id),
          { status: 'needs_attention', errorCode: 'TEST_FAILED' },
          'test',
          'failed',
        );
        throw new Error('Connection verification failed');
      }
    });
  }
  async rotate(id: string, revision: number, token: string, signal: AbortSignal) {
    return this.serial(async () => {
      let c = this.current(id, revision);
      if (
        !['active', 'needs_attention'].includes(c.status) ||
        this.store.pendingAssignments().some((x) => x.connectionId === id)
      )
        throw new Error('Connection cannot be rotated');
      await this.cleanupConnection(c);
      await this.gateway.verifyCompatibility(signal);
      await this.boundProvider(c, signal);
      const name = `mitzo-conn-${randomUUID()}`;
      this.store.startCandidate(id, name);
      let candidate = { ...c, gatewayProviderName: name, gatewayProviderId: null as string | null };
      let swapped = false;
      try {
        const provider = await this.gateway.provision({ name, token }, signal);
        this.checkProvider(candidate, provider);
        this.store.bindCandidate(name, provider.id);
        candidate = { ...candidate, gatewayProviderId: provider.id };
        const identity = await this.runProbe(candidate, signal);
        if (c.identity && identity.identity !== c.identity)
          throw new Error('Jira identity changed');
        c = this.change(c, { status: 'rotating', errorCode: null }, 'rotate', 'started');
        // Pause attached workloads before replacing the credential. Retained sessions keep their grant.
        for (const sandbox of await this.gateway.attachments(c.gatewayProviderName, signal)) {
          await this.gateway.stopSandbox(sandbox, signal);
          if (!(await this.gateway.sandboxStopped(sandbox, signal)))
            throw new Error('Sandbox shutdown pending');
        }
        swapped = true;
        await this.gateway.rotate({ name: c.gatewayProviderName, token }, signal);
        await this.gateway.delete(name, AbortSignal.timeout(30_000));
        this.store.finishCandidate(name);
        return this.change(
          c,
          {
            status: 'active',
            identity: identity.identity,
            verifiedAt: Date.now(),
            errorCode: null,
          },
          'rotate',
          'success',
        );
      } catch {
        const fresh = this.current(id);
        this.change(
          fresh,
          {
            status: swapped ? 'needs_attention' : c.status === 'rotating' ? 'active' : c.status,
            errorCode: 'ROTATION_FAILED',
          },
          'rotate',
          'failed',
        );
        throw new Error('Connection rotation failed');
      } finally {
        if (this.store.candidates().some((x) => x.name === name)) {
          try {
            const p = await this.gateway.get(name, AbortSignal.timeout(30_000));
            if (p) {
              this.checkProvider(candidate, p);
              await this.gateway.delete(name, AbortSignal.timeout(30_000));
            }
            this.store.finishCandidate(name);
          } catch {
            this.change(
              this.current(id),
              { status: 'needs_attention', errorCode: 'CLEANUP_PENDING' },
              'rotate',
              'cleanup_pending',
            );
          }
        }
      }
    });
  }
  private async revokeLocked(c: Connection, signal: AbortSignal) {
    if (c.status === 'revoked') return c;
    const pending =
      c.status === 'revoking' ? c : this.change(c, { status: 'revoking' }, 'revoke', 'started');
    try {
      await this.cleanupConnection(pending);
      await this.drain(pending, signal);
      if (await this.boundProvider(pending, signal, true))
        await this.gateway.delete(pending.gatewayProviderName, signal);
      this.store.finishAssignment(c.id);
      return this.change(
        pending,
        { status: 'revoked', desiredAccountIds: [], errorCode: null },
        'revoke',
        'success',
      );
    } catch {
      this.change(
        this.current(c.id),
        { status: 'revoking', errorCode: 'REVOKE_PENDING' },
        'revoke',
        'pending',
      );
      throw new Error('Connection revocation pending');
    }
  }
  async revoke(id: string, revision: number, actor: string, signal: AbortSignal) {
    return this.serial(async () => {
      const c = this.current(id, revision);
      if (actor !== c.ownerId) throw new Error('Connection owner mismatch');
      return this.revokeLocked(c, signal);
    });
  }
  async reconcile(signal: AbortSignal) {
    return this.serial(async () => {
      for (const op of this.store.pendingProbes()) {
        try {
          this.current(op.connectionId);
          if (
            op.gateway !== (this.options.gateway ?? 'openshell') ||
            op.workspace !== (this.options.workspace ?? 'default')
          )
            throw new Error('Gateway binding changed');
          await this.gateway.deleteSandbox(op.sandboxName, AbortSignal.timeout(30_000));
          this.store.finishProbe(op.id);
        } catch {
          this.store.probeCleanupPending(op.id);
        }
      }
      for (const op of this.store.candidates()) {
        try {
          const c = {
            ...this.current(op.connectionId),
            gatewayProviderName: op.name,
            gatewayProviderId: op.providerId,
          };
          const p = await this.gateway.get(op.name, signal);
          if (p) {
            this.checkProvider(c, p);
            await this.gateway.delete(op.name, signal);
          }
          this.store.finishCandidate(op.name);
        } catch {
          /* durable retry */
        }
      }
      for (const op of this.store.pendingAssignments()) {
        try {
          const c = this.current(op.connectionId);
          if (c.status === 'needs_attention' && c.errorCode === 'ASSIGNMENT_PENDING')
            await this.completeAssignment(c, op.accountIds, op.removedIds, signal);
        } catch {
          /* durable retry */
        }
      }
      for (const c of this.store.incomplete()) {
        if (c.status === 'revoking') {
          try {
            await this.revokeLocked(this.current(c.id), signal);
          } catch {
            /* durable retry */
          }
        } else
          this.change(
            c,
            { status: 'needs_attention', errorCode: 'RESUBMIT_REQUIRED' },
            'reconcile',
            'needs_attention',
          );
      }
    });
  }
}
