import { createUrlAccessTool, urlReadAccountIdentity } from './url-access-tool.js';
import {
  hasWebSearchGrant,
  saveWebSearchGrant,
  webSearchGrantRevision,
} from './web-search-grants.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type SessionRegistry,
  type ManagedSession,
} from '@mitzo/harness';
import { executeWebAccess, REQUEST_WEB_ACCESS, WebAccessInput } from './request-web-access.js';
import { fetchPublicPage } from './public-web-fetch.js';

const publicScopes = new WeakMap<
  ManagedSession,
  {
    account: ReturnType<typeof urlReadAccountIdentity>;
    revision: number;
    origins: Map<string, number>;
  }
>();
function publicScope(session: ManagedSession) {
  const account = urlReadAccountIdentity(session);
  let scope = publicScopes.get(session);
  if (!scope || !isDeepStrictEqual(scope.account, account)) {
    scope = { account, revision: (scope?.revision ?? -1) + 1, origins: new Map() };
    publicScopes.set(session, scope);
  }
  return scope;
}

export interface WebSearchExecutionOwner {
  parentSessionId: string;
  operationId: string;
}

/** Every runtime uses the same permission and session identity boundary. */
export function createWebAccessTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  search: (query: string, signal: AbortSignal, owner: WebSearchExecutionOwner) => Promise<string>,
) {
  const urlAccess = createUrlAccessTool(conversation, registry);
  return async (input: unknown, signal: AbortSignal) => {
    const operation =
      input && typeof input === 'object' && 'operation' in input ? input.operation : undefined;
    if (operation === 'request_access' || operation === 'revoke_access') {
      const result = await urlAccess.request(input, signal);
      if (
        !result.isError &&
        operation === 'revoke_access' &&
        input &&
        typeof input === 'object' &&
        'url' in input &&
        typeof input.url === 'string'
      ) {
        const current = registry.findBySessionId(
          typeof conversation === 'function' ? conversation() : conversation,
        );
        if (current) {
          const scope = publicScope(current.session);
          const origin = new URL(input.url).origin;
          scope.origins.set(origin, (scope.origins.get(origin) ?? 0) + 1);
        }
      }
      return result;
    }
    const parsed = WebAccessInput.safeParse(input);
    if (parsed.success && parsed.data.operation === 'fetch') {
      const granted = await urlAccess.fetch(parsed.data.url, signal);
      if (granted) return granted;
    }
    const operationId = randomUUID();
    const conversationId = typeof conversation === 'function' ? conversation() : conversation;
    const owner = registry.findBySessionId(conversationId);
    if (!owner) return { content: 'Session unavailable', isError: true };
    const { clientId, session } = owner;
    const binding = structuredClone(session.accountBinding);
    const model = session.model;
    const readScope = publicScope(session);
    // Retire stale bindings before capturing the pending approval generation.
    const searchAllowed = hasWebSearchGrant(session);
    const searchRevision = webSearchGrantRevision(session);
    const isCurrent = () =>
      registry.get(clientId) === session &&
      registry.findBySessionId(conversationId)?.session === session &&
      registry.findBySessionId(conversationId)?.clientId === clientId &&
      isDeepStrictEqual(session.accountBinding, binding) &&
      session.model === model &&
      webSearchGrantRevision(session) === searchRevision &&
      effectivePermissionMode(session) !== 'ask' &&
      checkSkillPolicy(registry, clientId, REQUEST_WEB_ACCESS) !== 'deny';
    return executeWebAccess(input, signal, {
      isCurrent,
      approve: async (request, signal, redirectedFrom) => {
        if (request.operation === 'search' && searchAllowed)
          return { behavior: 'allow', updatedInput: request };
        const decision = await buildPermissionHandler(clientId, registry)(
          REQUEST_WEB_ACCESS,
          request,
          {
            signal,
            toolUseID: operationId,
            forcePrompt: true,
            allowSessionGrant: request.operation === 'fetch',
            rememberSessionGrant: request.operation === 'fetch',
            approvalScope: 'session',
            ...(request.operation === 'fetch'
              ? {
                  sessionGrantKey:
                    'public-url-read:' +
                    createHash('sha256')
                      .update(
                        JSON.stringify({
                          account: readScope.account,
                          revision: readScope.revision,
                          origin: new URL(request.url).origin,
                          originRevision: readScope.origins.get(new URL(request.url).origin) ?? 0,
                        }),
                      )
                      .digest('hex'),
                  sessionGrantDescription: `Credential-free public HTTPS reads on ${new URL(request.url).origin} until this session ends. Other origins and changed account policy require separate consent. Network and DNS safety checks still apply to every read.`,
                }
              : {}),
            title: redirectedFrom
              ? 'Approve redirected destination?'
              : request.operation === 'search'
                ? 'Allow this web search?'
                : 'Allow this website read?',
            description: redirectedFrom
              ? `The approved page at ${new URL(redirectedFrom).origin} moved to ${request.operation === 'fetch' ? new URL(request.url).origin : ''}. Approve the destination to continue this read. Session access covers only this destination origin.`
              : request.operation === 'search'
                ? 'Runs searches using the selected account and model. Provider search and model charges may apply. Allow once, or allow searches until this session ends. Changing the account or model requires new consent.'
                : 'Reads this public HTTPS URL without credentials. Approval covers this origin and read only; shell networking and authenticated browsing remain restricted.',
          },
        );
        if (
          request.operation === 'search' &&
          decision.behavior === 'allow' &&
          decision.decisionClassification === 'user_permanent' &&
          !signal.aborted &&
          isCurrent() &&
          isDeepStrictEqual(decision.updatedInput, request)
        )
          saveWebSearchGrant(session);
        return decision;
      },
      search: (query, signal) =>
        search(query, signal, { parentSessionId: conversationId, operationId }),

      fetchPage: fetchPublicPage,
    });
  };
}
