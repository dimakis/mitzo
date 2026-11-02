import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  checkSkillPolicy,
  type buildPermissionHandler,
  type SessionRegistry,
} from '@mitzo/harness';
import type { ManagedSession } from './session-registry.js';

/** Called only after endpoint validation. Consent covers authenticated GETs for
 * one repository (or /user), separate from publication and shell networking. */
export function githubReadApproval(endpoint: string, session: ManagedSession, runtimeId?: string) {
  const repository = /^\/repos\/([^/]+\/[^/?]+)/.exec(endpoint)?.[1];
  const scope = repository ? `repository ${repository}` : 'the GitHub account identity';
  const binding = session.accountBinding;
  return {
    title: repository ? `Read GitHub repository ${repository}` : 'Read GitHub account identity',
    sessionGrantKey: `github-read-v1:${createHash('sha256')
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
    sessionGrantDescription: `Allow for session covers authenticated GitHub reads for ${scope}. Other repositories, writes and shell network access require separate permission.`,
  };
}

/** The same consent and delivery fence protects fresh reads and retained pages. */
export async function authorizeGitHubRead(
  input: { endpoint: string; view?: 'summary' | 'full' },
  options: {
    clientId: string;
    registry: SessionRegistry;
    session: ManagedSession;
    runtimeId?: string;
    signal: AbortSignal;
    toolUseID: string;
    decide: ReturnType<typeof buildPermissionHandler>;
    assertCurrentSync?: () => void;
    assertCurrentAsync?: () => Promise<void>;
  },
) {
  const { clientId, registry, session, runtimeId, signal } = options;
  const approval = githubReadApproval(input.endpoint, session, runtimeId);
  const permission = await options.decide('GitHubRead', input, {
    signal,
    toolUseID: options.toolUseID,
    forcePrompt: true,
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
      githubReadApproval(input.endpoint, session, runtimeId).sessionGrantKey !==
        approval.sessionGrantKey ||
      (permission.decisionClassification === 'user_permanent' &&
        !session.sessionAllowList.has(approval.sessionGrantKey))
    )
      throw Error('GitHub read permission changed; request approval again');
  };
  assertCurrent();
  return assertCurrent;
}
