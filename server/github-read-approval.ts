import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  checkSkillPolicy,
  type buildPermissionHandler,
  type SessionRegistry,
} from '@mitzo/harness';
import type { ManagedSession } from './session-registry.js';

export interface GitHubReadInput {
  endpoint: string;
  view?: 'summary' | 'full';
  access?: 'public' | 'authenticated';
}

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
  },
) {
  const { clientId, registry, session, runtimeId, signal } = options;
  const approval = githubReadApproval(input.endpoint, session, runtimeId, input.access);
  const permission = await options.decide('GitHubRead', input, {
    signal,
    toolUseID: options.toolUseID,
    forcePrompt: input.access !== 'public' || options.forcePrompt === true,
    allowSessionGrant: true,
    ...approval,
  });
  signal.throwIfAborted();
  if (permission.behavior !== 'allow') throw Error(permission.message);
  if (!isDeepStrictEqual(permission.updatedInput, input))
    throw Error('Tool input changed during approval; retry the tool');
  await options.assertCurrentAsync?.();
  const assertCurrent = () => {
    signal.throwIfAborted();
    options.assertCurrentSync?.();
    if (
      registry.get(clientId) !== session ||
      checkSkillPolicy(registry, clientId, 'GitHubRead') === 'deny' ||
      githubReadApproval(input.endpoint, session, runtimeId, input.access).sessionGrantKey !==
        approval.sessionGrantKey ||
      (permission.decisionClassification === 'user_permanent' &&
        !session.sessionAllowList.has(approval.sessionGrantKey))
    )
      throw Error('GitHub read permission changed; request approval again');
  };
  assertCurrent();
  return assertCurrent;
}
