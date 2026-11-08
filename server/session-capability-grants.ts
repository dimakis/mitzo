import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { effectivePermissionMode, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import { nativeCommandDirectoryScope } from './codex-native-grant-fence.js';

export const SessionCapability = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('development') }),
  z.strictObject({ kind: z.literal('public-web') }),
  z.strictObject({
    kind: z.literal('github-read'),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
  z.strictObject({
    kind: z.literal('google-read'),
    email: z.email().max(320),
    resource: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('file'), id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) }),
      z.strictObject({ kind: z.literal('drive-list') }),
      z.strictObject({
        kind: z.literal('calendar'),
        id: z.string().regex(/^[A-Za-z0-9_@.\-+]{1,256}$/),
      }),
    ]),
  }),
  z.strictObject({ kind: z.literal('telos-progress'), itemId: z.string().trim().min(1).max(200) }),
]);
export type SessionCapability = z.infer<typeof SessionCapability>;
export const CreateSessionCapabilityGrant = z.strictObject({
  sessionIds: z.array(z.string().min(1).max(200)).min(1).max(32),
  capability: SessionCapability,
  durationMinutes: z.number().int().min(1).max(480),
  scope: z.enum(['sessions', 'repository', 'operator']).optional(),
  expectedContexts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
});
export interface SessionCapabilityGrant {
  id: string;
  capability: SessionCapability;
  sessionIds: string[];
  expiresAt: number;
  scope?: 'sessions' | 'repository' | 'operator';
  repository?: string;
}
export interface SessionCapabilityInventory {
  sessionId: string;
  observedAt: number;
  grants: SessionCapabilityGrant[];
  sessions: Array<ReturnType<SessionCapabilityGrants['candidates']>[number] & { title: string }>;
  automaticReview: { state: 'unavailable'; reason: string };
}
interface Member {
  session: ManagedSession;
  snapshot: unknown;
  runtimeOwner: unknown;
  blockedOrigins: Set<string>;
}
interface Grant extends SessionCapabilityGrant {
  operatorId: string;
  members: Member[];
  timer?: ReturnType<typeof setTimeout>;
  account?: ManagedSession['accountBinding'];
  cancellation: AbortController;
}
export type CapabilityReceipt = (() => void) & {
  grantId: string;
  expiresAt: number;
  signal: AbortSignal;
};
const owners = new WeakMap<ManagedSession, SessionCapabilityGrants>();
const stores = new Set<WeakRef<SessionCapabilityGrants>>();
const identities = new WeakMap<object, string>();
function identity(owner: object) {
  let id = identities.get(owner);
  if (!id) {
    id = randomUUID();
    identities.set(owner, id);
  }
  return id;
}
const operator = (s: ManagedSession) =>
  s.ownedLocalAuthSessionId ?? s.ordinaryRuntimeOwner?.authSessionId;
const snapshot = (s: ManagedSession) =>
  structuredClone({
    sessionId: s.sessionId,
    account: s.accountBinding,
    cwd: s.cwd,
    worktrees: [...s.worktreePaths].map(([name, value]) => [name, value.path, value.wtId]).sort(),
    location: s.ordinaryRuntimeOwner?.location,
    // Remote paths belong to their retained runtime owner, never host lstat.
    directories: (s.ordinaryRuntimeOwner?.location === 'openshell'
      ? []
      : [s.cwd!, ...[...s.worktreePaths.values()].map((w) => w.path)]
    ).map((path) => {
      const proof = nativeCommandDirectoryScope(path, path);
      if (!proof || proof[0]!.length < 3) throw Error('Workspace directory unavailable');
      return proof;
    }),
  });
export function containsCapabilityPath(root: string, path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) return false;
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
/** Operator-only expiring consent. Survives attachment changes, never process
 * restart or session replacement. A captured receipt is rechecked at effect and
 * delivery boundaries; it cannot widen any native or service credential fence. */
export class SessionCapabilityGrants {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly registry: SessionRegistry,
    /** Server-owned custody identity, never a path or repository from tool JSON. */
    private readonly repository: (s: ManagedSession) => string | undefined = () => undefined,
  ) {
    stores.add(new WeakRef(this));
  }
  private scopeMatches(grant: Grant, s: ManagedSession) {
    return (
      isDeepStrictEqual(grant.account, s.accountBinding) &&
      (grant.scope !== 'repository' ||
        (s.accountBinding?.provider === 'openai-codex' &&
          s.ordinaryRuntimeOwner?.location !== 'openshell' &&
          this.repository(s) === grant.repository))
    );
  }
  private enroll(grant: Grant, s: ManagedSession): Member | undefined {
    if (!grant.scope || grant.scope === 'sessions') return;
    try {
      if (this.owned(grant.operatorId, s.sessionId!, true) !== s || !this.scopeMatches(grant, s))
        return;
      const member = {
        session: s,
        snapshot: snapshot(s),
        runtimeOwner: s.ordinaryRuntimeOwner?.identity,
        blockedOrigins: new Set<string>(),
      };
      grant.members.push(member);
      grant.sessionIds.push(s.sessionId!);
      owners.set(s, this);
      return member;
    } catch {
      return;
    }
  }
  private memberMatches(grant: Grant, member: Member): boolean {
    const s = member.session;
    try {
      return (
        operator(s) === grant.operatorId &&
        !s.abortController.signal.aborted &&
        effectivePermissionMode(s) !== 'ask' &&
        this.registry.findBySessionId(s.sessionId!, true)?.session === s &&
        s.ordinaryRuntimeOwner?.identity === member.runtimeOwner &&
        (!grant.scope || grant.scope === 'sessions' || this.scopeMatches(grant, s)) &&
        isDeepStrictEqual(snapshot(s), member.snapshot)
      );
    } catch {
      return false;
    }
  }
  private memberCurrent(grant: Grant, member: Member) {
    return grant.expiresAt > Date.now() && this.memberMatches(grant, member);
  }
  private async retire(grant: Grant) {
    this.grants.delete(grant.id);
    grant.cancellation.abort(Error('Capability grant expired or revoked'));
    clearTimeout(grant.timer);
    if (grant.capability.kind === 'development')
      await Promise.allSettled(
        grant.members
          .filter((member) => this.memberMatches(grant, member))
          .map((member) => Promise.resolve().then(() => member.session.queryInstance?.interrupt())),
      );
  }
  private prune() {
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) {
        void this.retire(grant);
        continue;
      }
      grant.members = grant.members.filter((m) => this.memberCurrent(grant, m));
      grant.sessionIds = grant.members.map((m) => m.session.sessionId!);
      if (!grant.members.length && (!grant.scope || grant.scope === 'sessions')) {
        clearTimeout(grant.timer);
        this.grants.delete(id);
      }
    }
  }
  private owned(operatorId: string, id: string, mutable = false) {
    const s = this.registry.findBySessionId(id)?.session;
    if (
      !operatorId ||
      !s ||
      operator(s) !== operatorId ||
      !s.accountBinding ||
      !s.cwd ||
      s.abortController.signal.aborted ||
      (mutable && effectivePermissionMode(s) === 'ask')
    )
      throw Error('Select a live Agent or Auto conversation owned by this login');
    return s;
  }
  candidates(operatorId: string) {
    return [...this.registry.entries()]
      .flatMap(([, s]) => {
        try {
          if (!s.sessionId || this.owned(operatorId, s.sessionId, true) !== s) return [];
          return [
            {
              sessionId: s.sessionId,
              cwd: s.cwd!,
              account: s.accountBinding!.accountId,
              mode: effectivePermissionMode(s),
              revision: this.selectionRevision(operatorId, s.sessionId),
              development:
                s.accountBinding?.provider === 'openai-codex' &&
                s.ordinaryRuntimeOwner?.location !== 'openshell',
              repository: this.repository(s),
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(0, 64);
  }
  selectionRevision(operatorId: string, sessionId: string) {
    const session = this.owned(operatorId, sessionId, true);
    return createHash('sha256')
      .update(
        JSON.stringify([
          operatorId,
          snapshot(session),
          this.repository(session),
          effectivePermissionMode(session),
          identity(session),
          session.ordinaryRuntimeOwner && identity(session.ordinaryRuntimeOwner.identity),
        ]),
      )
      .digest('hex');
  }
  create(operatorId: string, input: unknown): SessionCapabilityGrant {
    const parsed = CreateSessionCapabilityGrant.parse(input);
    const sessions = [...new Set(parsed.sessionIds)].map((id) => this.owned(operatorId, id, true));
    if (
      parsed.expectedContexts &&
      (Object.keys(parsed.expectedContexts).length !== sessions.length ||
        sessions.some(
          (s) =>
            parsed.expectedContexts![s.sessionId!] !==
            this.selectionRevision(operatorId, s.sessionId!),
        ))
    )
      throw Error('Selected conversation context changed; refresh Access');
    this.prune();
    if (this.grants.size >= 256) throw Error('Revoke an existing grant before adding another');
    const capability = parsed.capability;
    const scope = parsed.scope ?? 'sessions';
    const repository = scope === 'repository' ? this.repository(sessions[0]!) : undefined;
    if (
      (scope === 'repository' && (capability.kind !== 'development' || !repository)) ||
      (scope === 'operator' &&
        !['github-read', 'google-read', 'telos-progress'].includes(capability.kind)) ||
      (scope !== 'sessions' &&
        sessions.some(
          (s) =>
            !isDeepStrictEqual(s.accountBinding, sessions[0]!.accountBinding) ||
            (scope === 'repository' && this.repository(s) !== repository),
        ))
    )
      throw Error(
        'Select one repository and account for development, or an exact read/progress scope',
      );
    if (
      capability.kind === 'development' &&
      sessions.some(
        (s) =>
          s.accountBinding?.provider !== 'openai-codex' ||
          s.ordinaryRuntimeOwner?.location === 'openshell',
      )
    )
      throw Error('Development grants require native Local Codex conversations');
    const members = sessions.map((session) => {
      return {
        session,
        snapshot: snapshot(session),
        runtimeOwner: session.ordinaryRuntimeOwner?.identity,
        blockedOrigins: new Set<string>(),
      };
    });
    const grant: Grant = {
      id: randomUUID(),
      operatorId,
      capability,
      sessionIds: sessions.map((s) => s.sessionId!),
      members,
      cancellation: new AbortController(),
      expiresAt: Date.now() + parsed.durationMinutes * 60_000,
      ...(parsed.scope
        ? {
            scope,
            ...(repository ? { repository } : {}),
            account: structuredClone(sessions[0]!.accountBinding),
          }
        : {}),
    };
    this.grants.set(grant.id, grant);
    grant.timer = setTimeout(() => {
      void this.retire(grant);
    }, parsed.durationMinutes * 60_000);
    grant.timer.unref?.();
    sessions.forEach((s) => owners.set(s, this));
    return this.view(grant);
  }
  private view({
    id,
    capability,
    sessionIds,
    expiresAt,
    scope,
    repository,
  }: Grant): SessionCapabilityGrant {
    return structuredClone({
      id,
      capability,
      sessionIds,
      expiresAt,
      ...(scope ? { scope } : {}),
      ...(repository ? { repository } : {}),
    });
  }
  list(operatorId: string, sessionId: string): SessionCapabilityGrant[] {
    const session = this.owned(operatorId, sessionId);
    this.prune();
    for (const g of this.grants.values())
      if (g.operatorId === operatorId && !g.sessionIds.includes(sessionId)) this.enroll(g, session);
    return [...this.grants.values()]
      .filter((g) => g.operatorId === operatorId && g.sessionIds.includes(sessionId))
      .map((g) => this.view(g));
  }
  async revoke(operatorId: string, sessionId: string, id: string) {
    this.owned(operatorId, sessionId);
    const grant = this.grants.get(id);
    if (!grant || grant.operatorId !== operatorId || !grant.sessionIds.includes(sessionId))
      throw Error('Grant unavailable');
    await this.retire(grant);
  }
  blockPublicOrigin(session: ManagedSession, origin: string) {
    for (const grant of this.grants.values())
      if (grant.capability.kind === 'public-web')
        grant.members.find((m) => m.session === session)?.blockedOrigins.add(origin);
  }
  capture(
    session: ManagedSession,
    wanted:
      | { kind: 'development'; paths?: string[] }
      | { kind: 'public-web'; origin?: string }
      | { kind: 'github-read'; repository: string }
      | Extract<SessionCapability, { kind: 'google-read' | 'telos-progress' }>,
    grantId?: string,
  ): CapabilityReceipt | undefined {
    this.prune();
    for (const grant of this.grants.values()) {
      if (grantId && grant.id !== grantId) continue;
      const capability = grant.capability;
      if (capability.kind !== wanted.kind) continue;
      if (
        (capability.kind === 'google-read' || capability.kind === 'telos-progress') &&
        !isDeepStrictEqual(capability, wanted)
      )
        continue;
      if (
        capability.kind === 'github-read' &&
        wanted.kind === 'github-read' &&
        capability.repository.toLowerCase() !== wanted.repository.toLowerCase()
      )
        continue;
      if (capability.kind === 'development' && wanted.kind === 'development') {
        const roots = [session.cwd!, ...[...session.worktreePaths.values()].map((w) => w.path)];
        if (wanted.paths?.some((p) => !roots.some((root) => containsCapabilityPath(root, p))))
          continue;
      }
      const member =
        grant.members.find((m) => m.session === session) ?? this.enroll(grant, session);
      if (!member) continue;
      const blocked = () =>
        wanted.kind === 'public-web' &&
        wanted.origin !== undefined &&
        member.blockedOrigins.has(wanted.origin);
      if (blocked()) continue;
      return Object.assign(
        () => {
          if (
            this.grants.get(grant.id) !== grant ||
            !grant.members.includes(member) ||
            blocked() ||
            !this.memberCurrent(grant, member)
          )
            throw Error('Capability grant expired, revoked or changed');
        },
        { grantId: grant.id, expiresAt: grant.expiresAt, signal: grant.cancellation.signal },
      );
    }
  }
}
export function captureSessionCapability(
  session: ManagedSession,
  wanted: Parameters<SessionCapabilityGrants['capture']>[1],
  grantId?: string,
) {
  const known = owners.get(session)?.capture(session, wanted, grantId);
  if (known) return known;
  for (const ref of stores) {
    const store = ref.deref();
    if (!store) {
      stores.delete(ref);
      continue;
    }
    const receipt = store.capture(session, wanted, grantId);
    if (receipt) return receipt;
  }
}
export function blockSessionPublicOrigin(session: ManagedSession, origin: string) {
  owners.get(session)?.blockPublicOrigin(session, origin);
}
