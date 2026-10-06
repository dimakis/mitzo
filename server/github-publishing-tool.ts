import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type SessionRegistry,
} from '@mitzo/harness';
import type { ToolDefinition } from '@mitzo/harness';
import { getConnectionsRuntime } from './connections-runtime.js';
import {
  bindLiveCapabilityConversation,
  clearLiveCapabilityConversationBinding,
} from './capability-conversation-binding.js';
import { capabilityApprovalForConversation } from './connections/capabilities/approval.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
export const REQUEST_GITHUB_PUBLISH = 'RequestGithubPublish';
export const GithubPublishingFields = {
  repositoryPath: z.string().min(1).max(256),
  baseBranch: z.string().min(1).max(128),
  title: z.string().min(1).max(128),
  body: z.string().max(512),
  draft: z.boolean(),
};
const Input = z.object(GithubPublishingFields).strict();
export const githubPublishingDefinition: ToolDefinition = {
  name: REQUEST_GITHUB_PUBLISH,
  description:
    'Request approval to publish committed workspace changes to a GitHub feature branch and create or update its pull request. Mitzo selects the configured connection for this session account and can ask the user for a missing publishing grant. Credentials remain on the controller. Supply the local repository, base branch, title, body and draft choice; do not use direct GitHub writes.',
  input_schema: z.toJSONSchema(Input),
};
export const GITHUB_PUBLISHING_INSTRUCTIONS =
  '\nUse RequestGithubPublish to publish committed local changes to a GitHub feature branch and pull request. This tool is available across account runtimes and routes the request to the user for approval. It resolves access for the current AI account; a provider being read-only does not mean this approval-backed tool is unavailable. If a managed GitHub connection is missing, explain the returned setup requirement and preserve the local commit. Do not substitute direct git push or gh API writes after denial.\n';
export type GithubPublishingSource =
  | { runtime: 'host'; workspace: string; gitStorageRoots: readonly string[] }
  | { runtime: 'openshell'; workspace: string; sandboxName: string };
export function createGithubPublishingTool(
  conversation: string | (() => string),
  registry: SessionRegistry,
  source: () => GithubPublishingSource | undefined,
) {
  let bound:
    { conversationId: string; connectionId: string; connectionRevision: number } | undefined;
  const execute = async (
    input: unknown,
    signal: AbortSignal,
    call: { turnId: string; callId: string },
  ) => {
    try {
      signal.throwIfAborted();
      const parsed = Input.safeParse(input);
      if (!parsed.success) return { content: 'Invalid GitHub publishing request', isError: true };
      const conversationId = typeof conversation === 'function' ? conversation() : conversation;
      const owner = registry.findBySessionId(conversationId);
      const account = owner?.session.accountBinding;
      const runtime = getConnectionsRuntime();
      if (!owner || !account || !runtime)
        return {
          content:
            'GitHub publishing needs a configured managed GitHub connection in Connections. Local changes are preserved.',
          isError: true,
        };
      if (runtime.githubPublishEnabled === false)
        return {
          content:
            'The controller GitHub publisher is not configured. Configure its GitHub authorization before granting publishing access. Local changes are preserved.',
          isError: true,
        };
      const identity = structuredClone(account);
      const sourceIdentity = structuredClone(source());
      const isCurrent = () =>
        registry.get(owner.clientId) === owner.session &&
        registry.findBySessionId(conversationId)?.session === owner.session &&
        registry.findBySessionId(conversationId)?.clientId === owner.clientId &&
        isDeepStrictEqual(source(), sourceIdentity) &&
        isDeepStrictEqual(owner.session.accountBinding, identity) &&
        effectivePermissionMode(owner.session) !== 'ask' &&
        checkSkillPolicy(registry, owner.clientId, REQUEST_GITHUB_PUBLISH) !== 'deny';
      if (!isCurrent())
        return {
          content: 'Session permissions changed; retry the publishing request',
          isError: true,
        };
      const connections = runtime.store
        .list('operator')
        .filter(
          (c) =>
            c.templateId === 'github-readonly' &&
            c.status === 'active' &&
            c.desiredAccountIds.includes(account.accountId),
        );
      if (connections.length !== 1)
        return {
          content:
            'Assign one active managed GitHub connection to this AI account in Connections before publishing. Local changes are preserved.',
          isError: true,
        };
      const connection = connections[0]!;
      const currentConnection = () => {
        const current = runtime.store.get(connection.id);
        return (
          current?.status === 'active' &&
          current.revision === connection.revision &&
          current.desiredAccountIds.includes(identity.accountId)
        );
      };
      const grant = runtime.capabilityStore.getGrant(
        connection.id,
        connection.revision,
        'github.publish-pr',
        1,
      );
      if (grant?.status !== 'active' || !grant.accountIds.includes(account.accountId)) {
        const payload = {
          connectionId: connection.id,
          connectionRevision: connection.revision,
          accountId: account.accountId,
          capability: 'github.publish-pr',
          allowedRepositories: connection.publicConfig.allowedRepositories ?? [],
          allowedBaseBranches: connection.publicConfig.allowedBaseBranches ?? [],
        };
        const decision = await buildPermissionHandler(owner.clientId, registry)(
          REQUEST_GITHUB_PUBLISH,
          payload,
          {
            signal,
            toolUseID: randomUUID(),
            forcePrompt: true,
            allowSessionGrant: false,
            approvalScope: 'request',
            title: 'Enable GitHub publishing requests for this account?',
            description:
              'Enables the selected AI account to request publication within this connection’s repository and branch scope. Each publication still requires its own approval.',
          },
        );
        signal.throwIfAborted();
        if (decision.behavior !== 'allow')
          return {
            content: 'GitHub publishing access declined. Local changes are preserved.',
            isError: true,
          };
        if (
          !isCurrent() ||
          !currentConnection() ||
          !isDeepStrictEqual(decision.updatedInput, payload)
        )
          return { content: 'Publishing access changed during approval; retry', isError: true };
        runtime.capabilities.setGrant({
          connectionId: connection.id,
          connectionRevision: connection.revision,
          capabilityId: 'github.publish-pr',
          capabilityVersion: 1,
          accountIds: [
            ...new Set([
              ...(grant?.status === 'active' ? grant.accountIds : []),
              identity.accountId,
            ]),
          ],
          status: 'active',
        });
      }
      const resolved = source();
      if (!resolved || !isCurrent() || !currentConnection())
        return {
          content: 'The live publishing workspace is unavailable; reconnect before retrying',
          isError: true,
        };
      bound = {
        conversationId,
        connectionId: connection.id,
        connectionRevision: connection.revision,
      };
      bindLiveCapabilityConversation(conversationId, {
        ...resolved,
        accountId: identity.accountId,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        gatewayProviderId: connection.gatewayProviderId,
      });
      const operation = await runtime.capabilities.invoke(
        {
          connectionId: connection.id,
          connectionRevision: connection.revision,
          capabilityId: 'github.publish-pr',
          capabilityVersion: 1,
          accountId: identity.accountId,
          conversationId,
          turnId: call.turnId,
          idempotencyKey: createHash('sha256')
            .update(
              canonicalJson({
                conversationId,
                account: identity,
                connectionId: connection.id,
                revision: connection.revision,
                call,
                input: parsed.data,
              }),
            )
            .digest('hex'),
          input: { ...parsed.data, connectionId: connection.id },
        },
        signal,
        capabilityApprovalForConversation(registry, conversationId),
      );
      return {
        content: JSON.stringify({
          operationId: operation.id,
          status: operation.status,
          result: operation.result,
        }),
        isError: operation.status !== 'succeeded',
      };
    } catch {
      return {
        content:
          'GitHub publishing did not complete. Inspect the recorded operation before retrying; no fallback account was used.',
        isError: true,
      };
    }
  };
  return Object.assign(execute, {
    close: () => {
      if (bound) clearLiveCapabilityConversationBinding(bound.conversationId, bound);
      bound = undefined;
    },
  });
}

/** Caller supplies configured Git storage roots from host setup, never tool arguments. */
export function hostGithubPublishingSource(
  session: { cwd?: string },
  gitStorageRoots: readonly string[] = [],
): GithubPublishingSource | undefined {
  try {
    if (!session.cwd) return undefined;
    return {
      runtime: 'host',
      workspace: realpathSync(session.cwd),
      gitStorageRoots: gitStorageRoots.map((root) => realpathSync(root)),
    };
  } catch {
    return undefined;
  }
}
