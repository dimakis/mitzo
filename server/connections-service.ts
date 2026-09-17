import {
  ConnectionStore,
  ConnectionAssignmentConflictError,
  RevisionConflictError,
  type Connection,
} from './connections-store.js';
import { randomUUID } from 'node:crypto';
import {
  ConnectionProbeError,
  JIRA_TEMPLATE_ID,
  type ConnectionGateway,
  type GatewayProvider,
} from './connections-gateway.js';
import { connectionTemplateRegistry } from './connections/registry.js';
import type { ProviderPolicy } from './connections/types.js';
import { customRestProfileId } from './connections-gateway.js';

type CreateInput = Parameters<ConnectionStore['create']>[0];
export interface GenericConnectionCreateInput {
  ownerId: string;
  templateId: string;
  templateVersion: number;
  label: string;
  fields: Record<string, string | string[]>;
  desiredAccountIds: string[];
  gateway?: string;
  workspace?: string;
}
type Credentials = Record<string, string>;

function endpointFromPolicy(policy: ProviderPolicy) {
  const first = policy.endpoints[0];
  if (!first) throw new Error('Provider policy has no endpoints');
  return `https://${first.host}${first.port === 443 ? '' : `:${first.port}`}`;
}

function durablePublicConfig(policy: ProviderPolicy): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(policy.publicConfig).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : [...value],
    ]),
  );
}

function compatibilitySubmittedEmail(
  templateId: string,
  publicConfig: Record<string, string | string[]>,
) {
  return templateId === JIRA_TEMPLATE_ID && typeof publicConfig.email === 'string'
    ? publicConfig.email
    : undefined;
}

function isGenericCreateInput(
  input: CreateInput | GenericConnectionCreateInput,
): input is GenericConnectionCreateInput {
  return 'fields' in input;
}

function legacyCredentials(value: Credentials | string) {
  if (typeof value === 'string') return { token: value };
  return value;
}
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
  /** The gateway, not the browser, is authoritative for provisionable templates. */
  supportsTemplate(templateId: string, templateVersion: number) {
    return (
      connectionTemplateRegistry.getProviderTemplate(templateId, templateVersion) !== undefined &&
      this.gateway.supportsTemplate(templateId, templateVersion)
    );
  }
  resolveForAccount(accountId: string, ownerId = 'operator') {
    return (
      this.catalog(ownerId).find(
        (c) =>
          c.status === 'active' &&
          c.verifiedAt !== null &&
          c.gatewayProviderId &&
          c.desiredAccountIds.includes(accountId) &&
          // On-demand custom providers must be explicitly granted to a chat;
          // they are never selected by the automatic new-conversation path.
          (c.templateId !== 'custom-rest-readonly' ||
            c.publicConfig.attachmentMode === 'automatic'),
      ) ?? null
    );
  }
  /** Candidate custom providers for explicit per-conversation grants only. */
  onDemandForAccount(accountId: string, ownerId = 'operator') {
    return this.catalog(ownerId).filter(
      (c) =>
        c.templateId === 'custom-rest-readonly' &&
        c.status === 'active' &&
        c.verifiedAt !== null &&
        c.gatewayProviderId !== null &&
        c.desiredAccountIds.includes(accountId) &&
        c.publicConfig.attachmentMode === 'on-demand',
    );
  }
  private async authorizeOnDemandLocked(
    connectionId: string,
    revision: number,
    accountId: string,
    signal: AbortSignal,
  ) {
    const c = this.current(connectionId, revision);
    if (
      c.templateId !== 'custom-rest-readonly' ||
      c.status !== 'active' ||
      c.verifiedAt === null ||
      !c.gatewayProviderId ||
      c.publicConfig.attachmentMode !== 'on-demand' ||
      !c.desiredAccountIds.includes(accountId)
    )
      throw new Error('On-demand connection is no longer eligible');
    await this.boundProvider(c, signal);
    return c;
  }
  async authorizeOnDemand(
    connectionId: string,
    revision: number,
    accountId: string,
    signal: AbortSignal,
  ) {
    return this.serial(() =>
      this.authorizeOnDemandLocked(connectionId, revision, accountId, signal),
    );
  }
  /** Holds the connection mutation lock through physical attach and revalidates before release. */
  async grantOnDemand<T>(
    connectionId: string,
    revision: number,
    accountId: string,
    signal: AbortSignal,
    attach: () => Promise<T>,
    rollback: () => Promise<void>,
  ) {
    return this.serial(async () => {
      await this.authorizeOnDemandLocked(connectionId, revision, accountId, signal);
      try {
        const result = await attach();
        // Assignment/revocation/rotation cannot interleave while the lock is
        // held. Re-check anyway before returning a durable new attachment.
        await this.authorizeOnDemandLocked(connectionId, revision, accountId, signal);
        return result;
      } catch (error) {
        try {
          await rollback();
        } catch {
          // The caller still receives the failed grant; a retained attachment
          // is never considered approved until a later verified recovery.
        }
        throw error;
      }
    });
  }
  private current(id: string, revision?: number) {
    const c = this.store.get(id);
    if (!c || c.archivedAt !== null || c.ownerId !== 'operator')
      throw new Error('Connection not found');
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
    const expectedType =
      c.templateId === 'github-readonly'
        ? 'github'
        : c.templateId === 'custom-rest-readonly'
          ? customRestProfileId(this.policyFor(c))
          : c.templateId;
    if (
      p.name !== c.gatewayProviderName ||
      p.workspace !== c.workspace ||
      p.type !== expectedType ||
      (c.gatewayProviderId && p.id !== c.gatewayProviderId)
    )
      throw new Error('Managed provider binding changed');
    const validateBinding = this.gateway.validateBinding;
    if (typeof validateBinding !== 'function') throw new Error('Managed provider binding changed');
    validateBinding.call(this.gateway, {
      templateId: c.templateId,
      templateVersion: c.templateVersion,
      provider: p,
    });
  }
  private validateCredentials(
    templateId: string,
    templateVersion: number,
    credentials: Credentials | string,
  ) {
    const template = connectionTemplateRegistry.getProviderTemplate(templateId, templateVersion);
    if (!template) throw new Error('Connection credentials are invalid');
    const supplied = legacyCredentials(credentials);
    const allowedCredentialKeys = new Set(template.credentialFields.map((field) => field.key));
    if (
      Object.keys(supplied).some((key) => !allowedCredentialKeys.has(key)) ||
      template.credentialFields.some((field) => field.required && !supplied[field.key])
    )
      throw new Error('Connection credentials are invalid');
    return supplied;
  }
  private policyFor(c: Connection) {
    return connectionTemplateRegistry.compileProviderPolicy({
      templateId: c.templateId,
      templateVersion: c.templateVersion,
      fields: c.publicConfig,
    });
  }
  private async preparePolicy(policy: ProviderPolicy, signal: AbortSignal) {
    if (policy.templateId !== 'custom-rest-readonly') return policy;
    const prepare = this.gateway.preparePolicy;
    if (typeof prepare !== 'function')
      throw new Error('Custom REST gateway adapter is unavailable');
    return prepare.call(this.gateway, policy, signal);
  }
  private async boundProvider(c: Connection, signal: AbortSignal, allowMissing = false) {
    this.current(c.id);
    // Custom DNS is intentionally checked at every controller use, before a
    // provider can be selected for a new sandbox or retained-session action.
    if (c.templateId === 'custom-rest-readonly')
      await this.gateway.verifyCompatibility(
        { templateId: c.templateId, templateVersion: c.templateVersion, policy: this.policyFor(c) },
        signal,
      );
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
  async verifyRuntimeSandbox(
    name: string,
    connection: Connection | null,
    accountId: string,
    signal: AbortSignal,
    onDemandConnections: readonly Connection[] = [],
    approvedOnDemandProviderNames: readonly string[] = [],
  ) {
    const sandbox = await this.gateway.sandbox(name, signal);
    if (!sandbox) return;
    const providers = await this.gateway.sandboxProviders(name, signal);
    const managed = providers.filter((p) => p.startsWith('mitzo-conn-'));
    const managedOnDemandProviderNames = approvedOnDemandProviderNames.filter((provider) =>
      provider.startsWith('mitzo-conn-'),
    );
    const expected = [
      ...(connection?.gatewayProviderName.startsWith('mitzo-conn-')
        ? [connection.gatewayProviderName]
        : []),
      ...managedOnDemandProviderNames,
    ];
    if (managed.length !== expected.length || managed.some((p) => !expected.includes(p)))
      throw new Error('Connection permissions changed. Start a new conversation.');
    // A durable grant is only valid while its current connection revision
    // remains active for this account. This also repeats the custom DNS pin
    // verification before every retained-sandbox use.
    for (const providerName of managedOnDemandProviderNames) {
      const candidate = onDemandConnections.find(
        (connection) => connection.gatewayProviderName === providerName,
      );
      if (!candidate) throw new Error('Connection permissions changed. Start a new conversation.');
      await this.authorizeOnDemandLocked(candidate.id, candidate.revision, accountId, signal);
    }
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
  private hasQuarantine(id: string) {
    return this.store.pendingQuarantines().some((operation) => operation.connectionId === id);
  }
  /** Failed identity tests remove retained access before any retry can reactivate it. */
  private async quarantine(c: Connection) {
    const pending = this.hasQuarantine(c.id) ? this.current(c.id) : this.store.startQuarantine(c);
    try {
      // Podman stop/delete can take its 45-second default timeout. Quarantine
      // must wait long enough to remove retained sandbox access durably.
      await this.drain(pending, AbortSignal.timeout(90_000));
      this.store.finishQuarantine(pending.id);
    } catch {
      // The persisted operation is retried by reconcile with an independent signal.
    }
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
    this.store.completeAssignment(c.id, accountIds, c.ownerId);
  }
  async createAndProvision(
    input: CreateInput | GenericConnectionCreateInput,
    credentials: Credentials | string,
    signal: AbortSignal,
  ) {
    this.validateAccounts(input.desiredAccountIds);
    if (!isGenericCreateInput(input)) {
      // Database callers from pre-registry releases remain supported during migration.
      const c = this.store.create(input);
      return this.provision(c, legacyCredentials(credentials), signal);
    }
    const template = connectionTemplateRegistry.getProviderTemplate(
      input.templateId,
      input.templateVersion,
    );
    if (!template) throw new Error('Unknown provider template version');
    const supportsTemplate = this.gateway.supportsTemplate;
    if (
      typeof supportsTemplate !== 'function' ||
      !supportsTemplate.call(this.gateway, input.templateId, input.templateVersion)
    )
      throw new Error('Provider template is not available');
    let policy = connectionTemplateRegistry.compileProviderPolicy({
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      fields: input.fields,
    });
    policy = await this.preparePolicy(policy, signal);
    const publicConfig = durablePublicConfig(policy);
    const supplied = this.validateCredentials(input.templateId, input.templateVersion, credentials);
    const c = this.store.create({
      ownerId: input.ownerId,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      label: input.label,
      endpoint: endpointFromPolicy(policy),
      publicConfig,
      submittedEmail: compatibilitySubmittedEmail(input.templateId, publicConfig),
      gatewayProviderName: `mitzo-conn-${randomUUID()}`,
      gateway: input.gateway,
      workspace: input.workspace,
      desiredAccountIds: input.desiredAccountIds,
    });
    return this.provision(c, supplied, signal, policy);
  }
  private async runProbe(c: Connection, signal: AbortSignal) {
    const sandboxName = `mzp-${randomUUID().replaceAll('-', '').slice(0, 15)}`;
    const op = this.store.startProbe(c, sandboxName);
    let result: { identity: string } | undefined;
    let failure: unknown;
    try {
      result = await this.gateway.probe(
        {
          providerName: c.gatewayProviderName,
          templateId: c.templateId,
          templateVersion: c.templateVersion,
          publicConfig: c.publicConfig,
          sandboxName,
        },
        signal,
      );
    } catch (error) {
      failure = error;
      /* Cleanup still runs independently of probe failure or cancellation. */
    }
    try {
      // Cleanup is independent of the caller's deadline and must cover Podman's
      // 45-second default stop/delete timeout.
      await this.gateway.deleteSandbox(sandboxName, AbortSignal.timeout(90_000));
      this.store.finishProbe(op.id);
    } catch {
      this.store.probeCleanupPending(op.id);
      throw new Error('Probe cleanup pending');
    }
    if (failure instanceof ConnectionProbeError) throw failure;
    if (!result) throw new Error('Gateway identity probe failed');
    return result;
  }

  async retry(
    id: string,
    revision: number,
    credentials: Credentials | string,
    signal: AbortSignal,
  ) {
    const c = this.current(id, revision);
    return c.identity
      ? this.rotate(id, revision, credentials, signal)
      : this.provision(c, legacyCredentials(credentials), signal);
  }
  private async cleanupConnection(c: Connection) {
    for (const op of this.store.pendingProbes().filter((x) => x.connectionId === c.id)) {
      try {
        await this.gateway.deleteSandbox(op.sandboxName, AbortSignal.timeout(90_000));
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
  async provision(
    connection: Connection,
    credentials: Credentials | string,
    signal: AbortSignal,
    policy?: ProviderPolicy,
  ) {
    return this.serial(async () => {
      let c = this.current(connection.id, connection.revision);
      if (
        !['provisioning', 'needs_attention'].includes(c.status) ||
        c.identity ||
        this.store.pendingAssignments().some((x) => x.connectionId === c.id) ||
        this.hasQuarantine(c.id)
      )
        throw new Error('Connection cannot be provisioned');
      const supplied = this.validateCredentials(c.templateId, c.templateVersion, credentials);
      try {
        const resolvedPolicy = policy ?? this.policyFor(c);
        await this.cleanupConnection(c);
        await this.gateway.verifyCompatibility(
          { templateId: c.templateId, templateVersion: c.templateVersion, policy: resolvedPolicy },
          signal,
        );
        let p = await this.gateway.get(c.gatewayProviderName, signal);
        if (p) {
          this.checkProvider(c, p);
          // The generated durable name recovers a create whose response was lost.
          if (!c.gatewayProviderId)
            c = this.change(c, { gatewayProviderId: p.id }, 'provision', 'provider_recovered');
          await this.gateway.rotate(
            {
              name: c.gatewayProviderName,
              templateId: c.templateId,
              templateVersion: c.templateVersion,
              policy: resolvedPolicy,
              credentials: supplied,
            },
            signal,
          );
        } else {
          if (c.gatewayProviderId) throw new Error('Managed provider unavailable');
          p = await this.gateway.provision(
            {
              name: c.gatewayProviderName,
              templateId: c.templateId,
              templateVersion: c.templateVersion,
              policy: resolvedPolicy,
              credentials: supplied,
            },
            signal,
          );
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
      } catch (error) {
        this.change(
          this.current(c.id),
          {
            status: 'needs_attention',
            errorCode:
              error instanceof ConnectionProbeError
                ? error.code
                : error instanceof ConnectionAssignmentConflictError
                  ? 'ACCOUNT_ALREADY_ASSIGNED'
                  : 'PROVISION_FAILED',
          },
          'provision',
          'failed',
        );
        // Upstream failures may contain credential material; retain only the safe code.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Connection provisioning failed');
      }
    });
  }
  async test(id: string, revision: number, signal: AbortSignal) {
    return this.serial(async () => {
      const c = this.current(id, revision);
      if (
        !['active', 'needs_attention'].includes(c.status) ||
        this.store.pendingAssignments().some((x) => x.connectionId === id) ||
        this.hasQuarantine(id)
      )
        throw new Error('Connection cannot be tested');
      try {
        await this.cleanupConnection(c);
        await this.gateway.verifyCompatibility(
          {
            templateId: c.templateId,
            templateVersion: c.templateVersion,
            policy: this.policyFor(c),
          },
          signal,
        );
        await this.boundProvider(c, signal);
        const result = await this.runProbe(c, signal);
        if (c.identity && c.identity !== result.identity)
          throw new Error('Connection identity changed');
        return this.change(
          c,
          { status: 'active', identity: result.identity, verifiedAt: Date.now(), errorCode: null },
          'test',
          'success',
        );
      } catch (error) {
        await this.quarantine(this.current(id));
        if (
          (error instanceof ConnectionProbeError ||
            error instanceof ConnectionAssignmentConflictError) &&
          !this.hasQuarantine(id)
        ) {
          const quarantined = this.current(id);
          this.change(
            quarantined,
            {
              errorCode:
                error instanceof ConnectionProbeError ? error.code : 'ACCOUNT_ALREADY_ASSIGNED',
            },
            'test',
            'failed',
          );
        }
        // Upstream failures may contain credential material; retain only the safe code.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Connection verification failed');
      }
    });
  }
  async rotate(
    id: string,
    revision: number,
    credentials: Credentials | string,
    signal: AbortSignal,
  ) {
    return this.serial(async () => {
      let c = this.current(id, revision);
      if (
        !['active', 'needs_attention'].includes(c.status) ||
        this.store.pendingAssignments().some((x) => x.connectionId === id) ||
        this.hasQuarantine(id)
      )
        throw new Error('Connection cannot be rotated');
      const supplied = this.validateCredentials(c.templateId, c.templateVersion, credentials);
      await this.cleanupConnection(c);
      const policy = this.policyFor(c);
      await this.gateway.verifyCompatibility(
        { templateId: c.templateId, templateVersion: c.templateVersion, policy },
        signal,
      );
      await this.boundProvider(c, signal);
      const name = `mitzo-conn-${randomUUID()}`;
      this.store.startCandidate(id, name);
      let candidate = { ...c, gatewayProviderName: name, gatewayProviderId: null as string | null };
      let swapped = false;
      try {
        const provider = await this.gateway.provision(
          {
            name,
            templateId: c.templateId,
            templateVersion: c.templateVersion,
            policy,
            credentials: supplied,
          },
          signal,
        );
        this.checkProvider(candidate, provider);
        this.store.bindCandidate(name, provider.id);
        candidate = { ...candidate, gatewayProviderId: provider.id };
        const identity = await this.runProbe(candidate, signal);
        if (c.identity && identity.identity !== c.identity)
          throw new Error('Connection identity changed');
        c = this.change(c, { status: 'rotating', errorCode: null }, 'rotate', 'started');
        // Pause attached workloads before replacing the credential. Retained sessions keep their grant.
        for (const sandbox of await this.gateway.attachments(c.gatewayProviderName, signal)) {
          await this.gateway.stopSandbox(sandbox, signal);
          if (!(await this.gateway.sandboxStopped(sandbox, signal)))
            throw new Error('Sandbox shutdown pending');
        }
        swapped = true;
        await this.gateway.rotate(
          {
            name: c.gatewayProviderName,
            templateId: c.templateId,
            templateVersion: c.templateVersion,
            policy,
            credentials: supplied,
          },
          signal,
        );
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
      } catch (error) {
        const fresh = this.current(id);
        this.change(
          fresh,
          {
            status: swapped ? 'needs_attention' : c.status === 'rotating' ? 'active' : c.status,
            errorCode: error instanceof ConnectionProbeError ? error.code : 'ROTATION_FAILED',
          },
          'rotate',
          'failed',
        );
        // Probe output may carry upstream details; retain only the typed safe code.
        // eslint-disable-next-line preserve-caught-error
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
  async archive(id: string, revision: number, actor: string, signal: AbortSignal) {
    return this.serial(async () => {
      const c = this.current(id, revision);
      if (actor !== c.ownerId) throw new Error('Connection owner mismatch');
      const revoked = await this.revokeLocked(c, signal);
      if (
        this.store.pendingProbes().some((op) => op.connectionId === id) ||
        this.store.candidates().some((op) => op.connectionId === id) ||
        this.store.pendingAssignments().some((op) => op.connectionId === id) ||
        this.store.pendingQuarantines().some((op) => op.connectionId === id)
      )
        throw new Error('Connection cleanup is still pending');
      return this.store.archive(revoked.id, revoked.revision, actor);
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
          await this.gateway.deleteSandbox(op.sandboxName, AbortSignal.timeout(90_000));
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
          if (
            c.status === 'active' &&
            JSON.stringify(c.desiredAccountIds) === JSON.stringify(op.accountIds)
          )
            this.store.completeAssignment(c.id, op.accountIds, c.ownerId);
          else if (c.status === 'needs_attention' && c.errorCode === 'ASSIGNMENT_PENDING')
            await this.completeAssignment(c, op.accountIds, op.removedIds, signal);
        } catch {
          /* durable retry */
        }
      }
      for (const op of this.store.pendingQuarantines()) {
        try {
          const c = this.current(op.connectionId);
          await this.quarantine(c);
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
