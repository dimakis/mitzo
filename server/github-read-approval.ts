import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  checkSkillPolicy,
  type buildPermissionHandler,
  type SessionRegistry,
} from '@mitzo/harness';
import type { ManagedSession } from './session-registry.js';
import { captureSessionCapability } from './session-capability-grants.js';
import type { GithubLogRead } from './github-log-read.js';

export type GitHubReadInput = {
  log?: GithubLogRead;
  endpoint: string;
  view?: 'summary' | 'full';
  access?: 'public' | 'authenticated';
};

/** Called only after endpoint validation. Public and authenticated reads have
 * separate scopes; neither grants publication or shell networking. */
export function githubReadApproval(
  endpoint: string,
  session: ManagedSession,
  runtimeId?: string,
  access?: GitHubReadInput['access'],
) {
  const publicRead = access === 'public';
  const repository = /^\/repos\/([^/]+\/[^/?]+)/.exec(endpoint)?.[1];
  const scope = repository ? `repository ${repository}` : 'the GitHub account identity';
  const binding = session.accountBinding;
  return {
    title: repository
      ? `Read ${publicRead ? 'public ' : ''}GitHub repository ${repository}`
      : 'Read GitHub account identity',
    sessionGrantKey: `${publicRead ? 'github-public-read-v1' : 'github-read-v1'}:${createHash(
      'sha256',
    )
      .update(
        JSON.stringify([
          runtimeId ?? null,
          binding?.accountId,
          binding?.provider,
          binding?.profileRevision,
          session.ownedLocalAuthSessionId,
          repository ?? '/user',
        ]),
      )
      .digest('hex')}`,
    sessionGrantDescription: `Allow for session covers ${publicRead ? 'credential-free public' : 'authenticated'} GitHub reads for ${scope}. Other repositories, writes and shell network access require separate permission.`,
  };
}

/** The same consent and delivery fence protects fresh reads and retained pages. */
export async function authorizeGitHubRead(
  input: GitHubReadInput,
  options: {
    clientId: string;
    registry: SessionRegistry;
    session: ManagedSession;
    runtimeId?: string;
    signal: AbortSignal;
    toolUseID: string;
    decide: ReturnType<typeof buildPermissionHandler>;
    forcePrompt?: boolean;
    assertCurrentSync?: () => void;
    assertCurrentAsync?: () => Promise<void>;
    /** A separately approved task binds this repository, account and exact call. */
    assertTaskAuthorizationCurrent?: () => void;
  },
) {
  const { clientId, registry, session, runtimeId, signal } = options;
  const approval = githubReadApproval(input.endpoint, session, runtimeId, input.access);
  const repository = /^\/repos\/([^/]+\/[^/?]+)/.exec(input.endpoint)?.[1];
  const capability =
    repository && options.forcePrompt !== true
      ? captureSessionCapability(session, { kind: 'github-read', repository })
      : undefined;
  capability?.();
  const permission = capability
    ? {
        behavior: 'allow' as const,
        updatedInput: input,
        decisionClassification: 'user_temporary' as const,
      }
    : await options.decide('GitHubRead', input, {
        signal,
        toolUseID: options.toolUseID,
        forcePrompt: input.access !== 'public' || options.forcePrompt === true,
        allowSessionGrant: true,
        ...approval,
        ...(options.assertTaskAuthorizationCurrent && !options.forcePrompt
          ? {
              isRetainedSessionGrantCurrent: () => {
                options.assertTaskAuthorizationCurrent!();
                return true;
              },
            }
          : {}),
      });
  signal.throwIfAborted();
  if (permission.behavior !== 'allow') throw Error(permission.message);
  if (!isDeepStrictEqual(permission.updatedInput, input))
    throw Error('Tool input changed during approval; retry the tool');
  await options.assertCurrentAsync?.();
  const assertCurrent = () => {
    signal.throwIfAborted();
    options.assertCurrentSync?.();
    options.assertTaskAuthorizationCurrent?.();
    capability?.();
    if (
      registry.get(clientId) !== session ||
      checkSkillPolicy(registry, clientId, 'GitHubRead') === 'deny' ||
      githubReadApproval(input.endpoint, session, runtimeId, input.access).sessionGrantKey !==
        approval.sessionGrantKey ||
      (permission.decisionClassification === 'user_permanent' &&
        !options.assertTaskAuthorizationCurrent &&
        !session.sessionAllowList.has(approval.sessionGrantKey))
    )
      throw Error('GitHub read permission changed; request approval again');
  };
  assertCurrent();
  return assertCurrent;
}
