import { randomUUID } from 'node:crypto';
import { clearWebSearchGrant } from './web-search-grants.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import {
  ApprovedUrlRedirect,
  canonicalApprovalUrl,
  resolveApprovedUrl,
  fetchApprovedUrl,
  type ApprovedUrlTarget,
} from './approved-url-fetch.js';
import { REQUEST_WEB_ACCESS, withWebAbort, WebAccessError } from './request-web-access.js';
const Input = z
  .object({
    operation: z.enum(['request_access', 'revoke_access']),
    url: z.string().url().max(4000),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export function urlReadAccountIdentity(session: ManagedSession) {
  const account = session.accountBinding;
  return (
    account && {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    }
  );
}
interface Grant {
  target: ApprovedUrlTarget;
  account: ReturnType<typeof urlReadAccountIdentity>;
  expires: number;
}
const revisions = new WeakMap<ManagedSession, Map<string, number>>();
const grants = new WeakMap<ManagedSession, Map<string, Grant>>();
/** Explicit revocation retires URL approvals and pending approval generations. */
export function clearUrlAccessGrants(session: ManagedSession) {
  clearWebSearchGrant(session);
  grants.delete(session);
  const versions = revisions.get(session);
  for (const [origin, revision] of versions ?? []) versions!.set(origin, revision + 1);
}
interface Dependencies {
  resolve(value: string): Promise<ApprovedUrlTarget>;
  fetch(
    value: string,
    target: ApprovedUrlTarget,
    signal: AbortSignal,
    assertRuntimeCurrent?: () => Promise<void>,
    view?: 'summary' | 'full',
  ): Promise<string>;
  now(): number;
}
export function createUrlAccessTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  deps: Dependencies = {
    resolve: resolveApprovedUrl,
    fetch: (value, target, signal, assertCurrent, view) =>
      fetchApprovedUrl(value, target, signal, undefined, assertCurrent, view),
    now: Date.now,
  },
  assertRuntimeCurrent?: () => Promise<void>,
) {
  const owner = () =>
    registry.findBySessionId(typeof conversation === 'function' ? conversation() : conversation);
  const allowed = (clientId: string, session: ManagedSession) =>
    registry.get(clientId) === session &&
    owner()?.session === session &&
    owner()?.clientId === clientId &&
    effectivePermissionMode(session) !== 'ask' &&
    checkSkillPolicy(registry, clientId, REQUEST_WEB_ACCESS) !== 'deny';
  const pending = new Map<
    string,
    {
      promise: ReturnType<ReturnType<typeof buildPermissionHandler>>;
      payload: Record<string, unknown>;
      controller: AbortController;
      revision: number;
      waiters: number;
    }
  >();
  const tool = {
    async request(input: unknown, signal: AbortSignal, redirectedFrom?: string) {
      try {
        signal.throwIfAborted();
        const parsed = Input.safeParse(input);
        if (!parsed.success) return { content: 'Invalid URL access request', isError: true };
        const url = canonicalApprovalUrl(parsed.data.url);
        const current = owner();
        if (!current || !allowed(current.clientId, current.session))
          return { content: 'URL access is unavailable for this session mode', isError: true };
        let versions = revisions.get(current.session);
        if (!versions) {
          versions = new Map();
          revisions.set(current.session, versions);
        }
        const previous = grants.get(current.session)?.get(url.origin);
        if (
          parsed.data.operation === 'request_access' &&
          previous?.expires === Infinity &&
          isDeepStrictEqual(previous.account, urlReadAccountIdentity(current.session))
        )
          return {
            content: `URL read access is approved for ${url.origin} until this session ends.`,
            isError: false,
          };
        if (parsed.data.operation === 'revoke_access') {
          versions.set(url.origin, (versions.get(url.origin) ?? 0) + 1);
          grants.get(current.session)?.delete(url.origin);
          return { content: `URL read access revoked for ${url.origin}`, isError: false };
        }
        // Register pending origins before DNS/approval so session-wide clearing
        // advances every in-flight request, including the first on this origin.
        if (!versions.has(url.origin)) versions.set(url.origin, 0);
        const revision = versions.get(url.origin)!;
        const account = urlReadAccountIdentity(current.session);
        const target = await withWebAbort(
          deps.resolve(url.href),
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        );
        signal.throwIfAborted();
        if (versions.get(url.origin) !== revision)
          return { content: 'URL access changed during resolution; retry', isError: true };
        if (target.origin !== url.origin || !target.addresses.length)
          return { content: 'URL destination could not be resolved safely', isError: true };
        const payload = {
          ...parsed.data,
          url: url.href,
          origin: target.origin,
          resolvedAddresses: target.addresses.map((a) => a.address),
          access:
            'Credential-free HTTP GET reads on this origin: once for 15 minutes, or until this session ends when session access is selected',
        };
        const key = JSON.stringify({
          account,
          origin: target.origin,
          addresses: target.addresses.map((a) => [a.address, a.family]).sort(),
          revision,
        });
        let flight = pending.get(key);
        if (!flight) {
          const controller = new AbortController();
          flight = {
            controller,
            revision,
            payload,
            waiters: 0,
            promise: buildPermissionHandler(current.clientId, registry)(
              REQUEST_WEB_ACCESS,
              payload,
              {
                signal: controller.signal,
                toolUseID: randomUUID(),
                forcePrompt: true,
                allowSessionGrant: false,
                rememberSessionGrant: false,
                approvalScope: 'session',
                sessionGrantDescription: `Credential-free HTTP GET reads on ${target.origin} using only the reviewed resolved addresses, until this session ends or access is revoked. Other origins, credentials, and changed account policy require separate consent.`,
                title: redirectedFrom
                  ? 'Approve redirected destination?'
                  : 'Allow this session to read this website?',
                description:
                  (redirectedFrom
                    ? `The approved page at ${new URL(redirectedFrom).origin} moved to ${url.origin}. Approve the destination to continue this read. `
                    : '') +
                  'Allows credential-free reads through Mitzo’s web tool on the exact origin and resolved addresses shown below. Includes private or local destinations when explicitly shown. Other origins and credentials require separate access.',
              },
            ),
          };
          pending.set(key, flight);
          const created = flight;
          void flight.promise
            .finally(() => {
              if (pending.get(key) === created) pending.delete(key);
            })
            .catch(() => {});
        }
        flight.waiters++;
        let decision: Awaited<typeof flight.promise>;
        try {
          decision = await withWebAbort(flight.promise, signal);
        } finally {
          flight.waiters--;
          if (!flight.waiters) {
            flight.controller.abort();
            if (pending.get(key) === flight) pending.delete(key);
          }
        }
        await assertRuntimeCurrent?.();
        signal.throwIfAborted();
        if (decision.behavior !== 'allow') return { content: decision.message, isError: true };
        if (
          !allowed(current.clientId, current.session) ||
          !isDeepStrictEqual(urlReadAccountIdentity(current.session), account) ||
          (versions.get(url.origin) ?? 0) !== flight.revision ||
          !isDeepStrictEqual(decision.updatedInput, flight.payload)
        )
          return { content: 'URL access changed during approval; retry', isError: true };
        let sessionGrants = grants.get(current.session);
        if (!sessionGrants) {
          sessionGrants = new Map();
          grants.set(current.session, sessionGrants);
        }
        sessionGrants.set(target.origin, {
          target: structuredClone(target),
          account,
          expires:
            decision.decisionClassification === 'user_permanent'
              ? Infinity
              : deps.now() + 15 * 60 * 1000,
        });
        return {
          content: `URL read access approved for ${target.origin} ${decision.decisionClassification === 'user_permanent' ? 'until this session ends' : 'for 15 minutes in this session'}. Use RequestWebAccess with operation fetch to read pages on this origin, or revoke_access to remove access.`,
          isError: false,
        };
      } catch {
        return {
          content:
            'URL access request could not be completed. Check the URL and session before retrying.',
          isError: true,
        };
      }
    },
    async fetch(
      value: string,
      signal: AbortSignal,
      view?: 'summary' | 'full',
    ): Promise<{ content: string; isError: boolean } | undefined> {
      const current = owner();
      if (!current) return undefined;
      let url: URL;
      try {
        url = canonicalApprovalUrl(value);
      } catch {
        return undefined;
      }
      const grant = grants.get(current.session)?.get(url.origin);
      if (!grant) return undefined;
      if (!isDeepStrictEqual(grant.account, urlReadAccountIdentity(current.session)))
        clearUrlAccessGrants(current.session);
      if (
        grant.expires <= deps.now() ||
        !isDeepStrictEqual(grant.account, urlReadAccountIdentity(current.session))
      ) {
        return {
          content:
            'URL read access expired or the account changed. Use request_access to approve this origin again.',
          isError: true,
        };
      }
      if (!allowed(current.clientId, current.session))
        return { content: 'Session permissions changed; URL reads are unavailable', isError: true };
      const chain = [{ origin: url.origin, grant }];
      const chainCurrent = () => {
        if (
          chain.some(
            ({ grant }) =>
              !isDeepStrictEqual(grant.account, urlReadAccountIdentity(current.session)),
          )
        ) {
          clearUrlAccessGrants(current.session);
          return false;
        }
        return (
          allowed(current.clientId, current.session) &&
          chain.every(
            ({ origin, grant }) =>
              grants.get(current.session)?.get(origin) === grant && grant.expires > deps.now(),
          )
        );
      };
      let activeGrant = grant;
      try {
        for (let hop = 0; hop <= 3; hop++) {
          signal.throwIfAborted();
          if (!chainCurrent())
            return { content: 'Session permissions changed during URL read', isError: true };
          try {
            await assertRuntimeCurrent?.();
            const content = await deps.fetch(
              url.href,
              activeGrant.target,
              signal,
              assertRuntimeCurrent,
              view,
            );
            await assertRuntimeCurrent?.();
            signal.throwIfAborted();
            if (!chainCurrent())
              return { content: 'Session permissions changed during URL read', isError: true };
            return { content, isError: false };
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof ApprovedUrlRedirect)) throw error;
            if (!chainCurrent())
              return { content: 'Session permissions changed during URL read', isError: true };
            if (hop === 3)
              return { content: 'Approved read reached the redirect limit.', isError: true };
            const destination = canonicalApprovalUrl(error.url);
            // Never reuse the source grant for a new origin, including private hosts.
            const decision = await tool.request(
              {
                operation: 'request_access',
                url: destination.href,
                reason: 'Continue the approved website read after a redirect',
              },
              signal,
              url.href,
            );
            signal.throwIfAborted();
            const destinationGrant = grants.get(current.session)?.get(destination.origin);
            if (!decision.isError && destinationGrant) {
              // Explicit reapproval may replace a prior origin's grant. Keep
              // its expiry fence and track the newly accepted grant identity.
              for (const entry of chain.filter(({ origin }) => origin === destination.origin)) {
                if (entry.grant.expires <= deps.now())
                  return { content: 'Session permissions changed during URL read', isError: true };
                entry.grant = destinationGrant;
              }
            }
            if (!chainCurrent())
              return { content: 'Session permissions changed during URL read', isError: true };
            if (decision.isError) return decision;
            if (!destinationGrant)
              return { content: 'URL access changed during approval; retry', isError: true };
            url = destination;
            activeGrant = destinationGrant;
            chain.push({ origin: url.origin, grant: activeGrant });
          }
        }
        return { content: 'Approved read reached the redirect limit.', isError: true };
      } catch (error) {
        return {
          content: signal.aborted
            ? 'Web access interrupted'
            : error instanceof WebAccessError
              ? error.message
              : 'Approved read could not connect securely to the website. Retry the read.',
          isError: true,
        };
      }
    },
  };
  return tool;
}
