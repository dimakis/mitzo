import { createUrlAccessTool } from './url-access-tool.js';
import {
  hasWebSearchGrant,
  saveWebSearchGrant,
  webSearchGrantRevision,
} from './web-search-grants.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type SessionRegistry,
} from '@mitzo/harness';
import { executeWebAccess, REQUEST_WEB_ACCESS, WebAccessInput } from './request-web-access.js';
import { fetchPublicPage } from './public-web-fetch.js';

/** Every runtime uses the same permission and session identity boundary. */
export function createWebAccessTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  search: (query: string, signal: AbortSignal) => Promise<string>,
) {
  const urlAccess = createUrlAccessTool(conversation, registry);
  return async (input: unknown, signal: AbortSignal) => {
    const operation =
      input && typeof input === 'object' && 'operation' in input ? input.operation : undefined;
    if (operation === 'request_access' || operation === 'revoke_access')
      return urlAccess.request(input, signal);
    const parsed = WebAccessInput.safeParse(input);
    if (parsed.success && parsed.data.operation === 'fetch') {
      const granted = await urlAccess.fetch(parsed.data.url, signal);
      if (granted) return granted;
    }
    const conversationId = typeof conversation === 'function' ? conversation() : conversation;
    const owner = registry.findBySessionId(conversationId);
    if (!owner) return { content: 'Session unavailable', isError: true };
    const { clientId, session } = owner;
    const binding = structuredClone(session.accountBinding);
    const model = session.model;
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
      approve: async (request, signal) => {
        if (request.operation === 'search' && searchAllowed)
          return { behavior: 'allow', updatedInput: request };
        const decision = await buildPermissionHandler(clientId, registry)(
          REQUEST_WEB_ACCESS,
          request,
          {
            signal,
            toolUseID: randomUUID(),
            forcePrompt: true,
            allowSessionGrant: false,
            rememberSessionGrant: false,
            approvalScope: request.operation === 'search' ? 'session' : 'request',
            title:
              request.operation === 'search'
                ? 'Allow this web search?'
                : 'Allow this website read?',
            description:
              request.operation === 'search'
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
      search,
      fetchPage: fetchPublicPage,
    });
  };
}
