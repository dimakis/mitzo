import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
/** Read the existing native SDK history owner at the original workspace only.
 * Never search other project directories or synthesize a replacement thread. */
export async function assertOrdinaryLocalVertexHistory(sdkSessionId: string, cwd: string) {
  const info = await getSessionInfo(sdkSessionId, { dir: cwd });
  if (!info || info.sessionId !== sdkSessionId || info.cwd !== cwd)
    throw Error('Original SDK history unavailable');
  const messages = await getSessionMessages(sdkSessionId, { dir: cwd, limit: 1 });
  if (!messages.length) throw Error('Original SDK history unavailable');
}
