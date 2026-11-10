import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { readClaudeAccountHistory } from './claude-account-history.js';
/** Read the existing native SDK history owner at the original workspace only.
 * Never search other project directories or synthesize a replacement thread. */
export async function assertOrdinaryLocalVertexHistory(
  sdkSessionId: string,
  cwd: string,
  configDirectory?: string,
) {
  if (configDirectory) {
    const { info, messages } = await readClaudeAccountHistory(sdkSessionId, cwd, configDirectory);
    if (!info || info.sessionId !== sdkSessionId || info.cwd !== cwd || !messages.length)
      throw Error('Original SDK history unavailable');
    return;
  }
  const info = await getSessionInfo(sdkSessionId, { dir: cwd });
  if (!info || info.sessionId !== sdkSessionId || info.cwd !== cwd)
    throw Error('Original SDK history unavailable');
  const messages = await getSessionMessages(sdkSessionId, { dir: cwd, limit: 1 });
  if (!messages.length) throw Error('Original SDK history unavailable');
}
