import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PrMonitorSubscription } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthSession } from './interactive-auth-core.js';
import type { Connection } from './connections-store.js';
import type { GitHubReadResponse } from './github-read-response.js';
import { githubMonitorPullSchema } from './pr-monitor-github.js';
import { createPrMonitorObservationRuntime } from './pr-monitor-runtime.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const PrMonitorRegisterSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  connectionId: z.uuid(),
  connectionRevision: z.number().int().positive(),
  owner: z.string().regex(/^[\w.-]{1,100}$/),
  name: z.string().regex(/^[\w.-]{1,100}$/),
  pr: z.number().int().positive(),
  expectedExecutionDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
type ManagedConnection = Pick<
  Connection,
  | 'id'
  | 'ownerId'
  | 'templateId'
  | 'status'
  | 'revision'
  | 'identity'
  | 'verifiedAt'
  | 'archivedAt'
  | 'desiredAccountIds'
  | 'publicConfig'
>;
type Options = {
  eventStore: EventStore;
  execution(conversationId: string): PrMonitorSubscription['execution'];
  connection(id: string): ManagedConnection | undefined;
  auth: Pick<
    Parameters<typeof createPrMonitorObservationRuntime>[0]['consent'],
    'hasPersistentRevocationAuthority' | 'isInteractive' | 'isLoginCurrent'
  >;
  read(
    endpoint: string,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<GitHubReadResponse>;
  eligibleAuthors: readonly string[];
};
/** Application-owned registration/observation only. No browser attachment, model
 * process or command is created to reconcile a retained explicit Watch. */
export function createPrMonitorController(options: Options) {
  let closed = false;
  const pending = new Map<string, Promise<ReturnType<typeof registered>>>();
  const registrations = new Set<AbortController>();
  const authorize = (auth: AuthSession) => {
    if (
      closed ||
      !options.auth.hasPersistentRevocationAuthority() ||
      !options.auth.isLoginCurrent(auth) ||
      !options.auth.isInteractive(auth.id)
    )
      throw Error('authority_unavailable');
  };
  const selectedConnection = (
    id: string,
    revision: string,
    repository: string,
    accountId: string,
  ) => {
    const c = options.connection(id);
    if (
      !c ||
      c.id !== id ||
      c.ownerId !== 'operator' ||
      c.templateId !== 'github-readonly' ||
      c.status !== 'active' ||
      String(c.revision) !== revision ||
      !c.identity ||
      !c.verifiedAt ||
      c.archivedAt !== null ||
      !c.desiredAccountIds.includes(accountId) ||
      !Array.isArray(c.publicConfig.allowedRepositories) ||
      !c.publicConfig.allowedRepositories.some((r) => r.toLowerCase() === repository.toLowerCase())
    )
      throw Error('connection_unavailable');
    return c;
  };
  const connectionFor = (s: PrMonitorSubscription) =>
    selectedConnection(
      s.github.connectionId,
      s.github.identityRevision,
      `${s.github.owner}/${s.github.name}`,
      s.execution.binding.account.accountId,
    );
  const scope = (s: PrMonitorSubscription) => {
    connectionFor(s);
    if (!s.github.principalId) throw Error('connection_unavailable');
    return {
      connectionId: s.github.connectionId,
      connectionRevision: s.github.identityRevision,
      githubPrincipalId: s.github.principalId,
      repositoryId: s.github.repositoryId,
      prNodeId: s.github.prNodeId,
    };
  };
  const assertConversation = (s: PrMonitorSubscription) => {
    if (closed || !isDeepStrictEqual(options.execution(s.conversationId), s.execution))
      throw Error('conversation_unavailable');
  };
  async function read(
    endpoint: string,
    signal: AbortSignal,
    current: () => void,
    identity: string,
  ) {
    signal.throwIfAborted();
    current();
    let abort = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(Error('read_aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    let response: GitHubReadResponse;
    try {
      response = await Promise.race([options.read(endpoint, signal, current), cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
    current();
    if (endpoint === '/user' && response.status === 200) {
      const actual = z
        .object({ id: z.number().int().positive(), login: z.string() })
        .parse(response.data);
      if (actual.login.toLowerCase() !== identity.toLowerCase())
        throw Error('connection_unavailable');
    }
    return response;
  }
  const runtime = createPrMonitorObservationRuntime({
    eventStore: options.eventStore,
    eligibleAuthors: options.eligibleAuthors,
    consent: { ...options.auth, assertConversation, connection: scope },
    transport: (endpoint, signal, current, request) =>
      read(endpoint, signal, current, connectionFor(request.subscription).identity!),
  });
  function registered(auth: AuthSession, conversationId: string, id: string) {
    authorize(auth);
    const projection = options.eventStore.prMonitor.projection('ordinary:user', conversationId, id);
    assertConversation(projection.subscription);
    return { projection, reviewedScope: scope(projection.subscription) };
  }
  const context = (auth: AuthSession, id: string) => {
    authorize(auth);
    return { executionDigest: digest(options.execution(id)) };
  };
  async function register(auth: AuthSession, conversationId: string, raw: unknown) {
    const input = PrMonitorRegisterSchema.parse(raw);
    authorize(auth);
    const execution = structuredClone(options.execution(conversationId));
    if (digest(execution) !== input.expectedExecutionDigest) throw Error('execution_changed');
    const original = structuredClone(
      selectedConnection(
        input.connectionId,
        String(input.connectionRevision),
        `${input.owner}/${input.name}`,
        execution.binding.account.accountId,
      ),
    );
    const hex = digest(['pr-registration-v1', conversationId, input.requestId]);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const existing = options.eventStore.prMonitor
      .list('ordinary:user', conversationId)
      .find((v) => v.subscription.id === id);
    if (existing) {
      const s = existing.subscription;
      if (
        s.github.connectionId !== input.connectionId ||
        s.github.identityRevision !== String(input.connectionRevision) ||
        s.github.owner.toLowerCase() !== input.owner.toLowerCase() ||
        s.github.name.toLowerCase() !== input.name.toLowerCase() ||
        s.github.pr !== input.pr ||
        !isDeepStrictEqual(s.execution, execution)
      )
        throw Error('request_conflict');
      return registered(auth, conversationId, id);
    }
    const key = digest([auth.id, conversationId, input]);
    if (pending.has(key)) return pending.get(key)!;
    const controller = new AbortController();
    registrations.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    const current = () => {
      signal.throwIfAborted();
      authorize(auth);
      if (!isDeepStrictEqual(execution, options.execution(conversationId)))
        throw Error('execution_changed');
      if (
        !isDeepStrictEqual(
          original,
          selectedConnection(
            input.connectionId,
            String(input.connectionRevision),
            `${input.owner}/${input.name}`,
            execution.binding.account.accountId,
          ),
        )
      )
        throw Error('connection_unavailable');
    };
    const operation = (async () => {
      // This first identity probe is part of the explicit interactive registration,
      // never a background read or promotion of an ephemeral GitHub tool grant.
      const identity = await read('/user', signal, current, original.identity!);
      if (identity.status !== 200) throw Error('connection_unavailable');
      const principal = z.object({ id: z.number().int().positive() }).parse(identity.data);
      const principalId = `github:${principal.id}`;
      const endpoint = `/repos/${input.owner}/${input.name}/pulls/${input.pr}`;
      const first = await read(endpoint, signal, current, original.identity!);
      if (first.status !== 200) throw Error('pr_unavailable');
      const p = githubMonitorPullSchema.parse(first.data);
      const final = await read(endpoint, signal, current, original.identity!);
      if (final.status !== 200 || !isDeepStrictEqual(p, githubMonitorPullSchema.parse(final.data)))
        throw Error('pr_changed');
      if (
        p.number !== input.pr ||
        p.base.repo.owner.login.toLowerCase() !== input.owner.toLowerCase() ||
        p.base.repo.name.toLowerCase() !== input.name.toLowerCase() ||
        p.merged
      )
        throw Error('pr_unavailable');
      current();
      options.eventStore.prMonitor.create(`pr-register:${id}`, {
        version: 1,
        id,
        revision: 1,
        operatorId: 'ordinary:user',
        conversationId,
        github: {
          connectionId: input.connectionId,
          identityRevision: String(input.connectionRevision),
          principalId,
          repositoryId: p.base.repo.node_id,
          prNodeId: p.node_id,
          owner: p.base.repo.owner.login,
          name: p.base.repo.name,
          pr: p.number,
        },
        execution,
        head: null,
        watch: null,
        autoFix: null,
        merge: null,
        lifecycle: 'paused',
        lastAttemptAt: null,
        lastSuccessfulRefreshAt: null,
        nextRefreshAt: null,
        snapshotRevision: 0,
        eligibilityRevision: 0,
        eligibilityDigest: digest([]),
      });
      return registered(auth, conversationId, id);
    })().finally(() => {
      pending.delete(key);
      registrations.delete(controller);
    });
    pending.set(key, operation);
    return operation;
  }
  return {
    consent: runtime.consent,
    context,
    register,
    list: (auth: AuthSession, id: string) => {
      authorize(auth);
      options.execution(id);
      return options.eventStore.prMonitor
        .list('ordinary:user', id)
        .map((v) =>
          options.eventStore.prMonitor.projection('ordinary:user', id, v.subscription.id),
        );
    },
    reconcileDue: runtime.reconcileDue,
    stopConversation: runtime.stopConversation,
    close: async () => {
      closed = true;
      for (const controller of registrations) controller.abort();
      await Promise.allSettled([...pending.values(), runtime.close()]);
    },
  };
}
export type PrMonitorController = ReturnType<typeof createPrMonitorController>;
