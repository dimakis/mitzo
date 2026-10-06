import { randomUUID } from 'node:crypto';
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
  canonicalApprovalUrl,
  resolveApprovedUrl,
  fetchApprovedUrl,
  type ApprovedUrlTarget,
} from './approved-url-fetch.js';
import { REQUEST_WEB_ACCESS, withWebAbort } from './request-web-access.js';
const Input = z
  .object({
    operation: z.enum(['request_access', 'revoke_access']),
    url: z.string().url().max(4000),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
interface Grant {
  target: ApprovedUrlTarget;
  account: ManagedSession['accountBinding'];
  model: ManagedSession['model'];
  expires: number;
}
const revisions = new WeakMap<ManagedSession, Map<string, number>>();
const grants = new WeakMap<ManagedSession, Map<string, Grant>>();
interface Dependencies {
  resolve(value: string): Promise<ApprovedUrlTarget>;
  fetch(value: string, target: ApprovedUrlTarget, signal: AbortSignal): Promise<string>;
  now(): number;
}
export function createUrlAccessTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  deps: Dependencies = { resolve: resolveApprovedUrl, fetch: fetchApprovedUrl, now: Date.now },
) {
  const owner = () =>
    registry.findBySessionId(typeof conversation === 'function' ? conversation() : conversation);
  const allowed = (clientId: string, session: ManagedSession) =>
    registry.get(clientId) === session &&
    owner()?.session === session &&
    owner()?.clientId === clientId &&
    effectivePermissionMode(session) !== 'ask' &&
    checkSkillPolicy(registry, clientId, REQUEST_WEB_ACCESS) !== 'deny';
  return {
    async request(input: unknown, signal: AbortSignal) {
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
        const revision = (versions.get(url.origin) ?? 0) + 1;
        versions.set(url.origin, revision);
        if (parsed.data.operation === 'revoke_access') {
          grants.get(current.session)?.delete(url.origin);
          return { content: `URL read access revoked for ${url.origin}`, isError: false };
        }
        const account = structuredClone(current.session.accountBinding);
        const model = current.session.model;
        const target = await withWebAbort(
          deps.resolve(url.href),
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        );
        signal.throwIfAborted();
        if (target.origin !== url.origin || !target.addresses.length)
          return { content: 'URL destination could not be resolved safely', isError: true };
        const payload = {
          ...parsed.data,
          url: url.href,
          origin: target.origin,
          resolvedAddresses: target.addresses.map((a) => a.address),
          access:
            'Credential-free HTTP GET reads on this origin for 15 minutes or until this session closes',
        };
        const decision = await buildPermissionHandler(current.clientId, registry)(
          REQUEST_WEB_ACCESS,
          payload,
          {
            signal,
            toolUseID: randomUUID(),
            forcePrompt: true,
            allowSessionGrant: false,
            approvalScope: 'request',
            title: 'Allow this session to read this website?',
            description:
              'Allows credential-free reads through Mitzo’s web tool on the exact origin and resolved addresses shown below. Includes private or local destinations when explicitly shown. Other origins and credentials require separate access.',
          },
        );
        signal.throwIfAborted();
        if (decision.behavior !== 'allow') return { content: 'URL access declined', isError: true };
        if (
          !allowed(current.clientId, current.session) ||
          !isDeepStrictEqual(current.session.accountBinding, account) ||
          current.session.model !== model ||
          versions.get(url.origin) !== revision ||
          !isDeepStrictEqual(decision.updatedInput, payload)
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
          model,
          expires: deps.now() + 15 * 60 * 1000,
        });
        return {
          content: `URL read access approved for ${target.origin} for 15 minutes in this session. Use RequestWebAccess with operation fetch to read pages on this origin, or revoke_access to remove access.`,
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
      if (
        grant.expires <= deps.now() ||
        !isDeepStrictEqual(grant.account, current.session.accountBinding) ||
        grant.model !== current.session.model
      ) {
        grants.get(current.session)?.delete(url.origin);
        return undefined;
      }
      if (!allowed(current.clientId, current.session))
        return { content: 'Session permissions changed; URL reads are unavailable', isError: true };
      try {
        signal.throwIfAborted();
        const content = await deps.fetch(url.href, grant.target, signal);
        signal.throwIfAborted();
        if (
          grants.get(current.session)?.get(url.origin) !== grant ||
          grant.expires <= deps.now() ||
          !allowed(current.clientId, current.session) ||
          !isDeepStrictEqual(grant.account, current.session.accountBinding) ||
          grant.model !== current.session.model
        )
          return { content: 'Session permissions changed during URL read', isError: true };
        return { content, isError: false };
      } catch {
        return {
          content:
            'Approved URL read failed. Check website reachability or authorization; request access again if its resolved destination changed.',
          isError: true,
        };
      }
    },
  };
}
