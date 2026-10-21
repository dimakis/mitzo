import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';
import type { MainPublicationPermission } from './telos-main-publication.js';
import {
  normalPrPublicationContract,
  RequestGithubMainPublicationSchema,
} from './telos-main-publication-contract.js';

/** Existing ordinary permission owner; deliberately no route or native registry.
 * Core composes this with its real signed owner/currentness checks. */
export async function approveGithubMainPublication(
  registry: SessionRegistry,
  clientId: string,
  presentation: MainPublicationPermission,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<{ receiptId: string } | undefined> {
  const session = registry.get(clientId);
  if (
    presentation.pins.contract !== normalPrPublicationContract ||
    !RequestGithubMainPublicationSchema.safeParse(presentation.pins.input).success
  )
    return undefined;
  if (
    !session?.sessionId ||
    session.sessionId !== presentation.pins.authority.conversationId ||
    registry.findBySessionId(session.sessionId)?.session !== session
  )
    return undefined;
  assertCurrent();
  const receiptId = randomUUID();
  const input = { ...structuredClone(presentation.pins) };
  const expected = structuredClone(input);
  const decision = await buildPermissionHandler(clientId, registry)(presentation.toolName, input, {
    signal,
    toolUseID: receiptId,
    forcePrompt: true,
    allowSessionGrant: false,
    rememberSessionGrant: false,
    approvalScope: 'request',
    title: 'Merge this reviewed PR into main?',
    description: `Squash merge ${input.authority.repository} PR #${input.input.pullRequest}, exact source ${input.input.sourceHead}; work ${input.input.itemId}@${input.input.workRevision}. Applies once to this PR, source and current work authority. Main may advance under current normal remote CI, review and strict up-to-date protections; no fixed main revision is approved. Publication holds and currentness are rechecked at effect admission. A changed source requires fresh approval.`,
  });
  signal.throwIfAborted();
  assertCurrent();
  if (
    registry.get(clientId) !== session ||
    registry.findBySessionId(session.sessionId)?.clientId !== clientId ||
    decision.behavior !== 'allow' ||
    !isDeepStrictEqual(decision.updatedInput, expected)
  )
    return undefined;
  return { receiptId };
}
