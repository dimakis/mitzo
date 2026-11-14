import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { readClaudeAccountHistory } from './claude-account-history.js';
/** Read the existing native SDK history owner at the original workspace only.
 * Never search other project directories or synthesize a replacement thread. */
export async function assertOrdinaryLocalVertexHistory(
  sdkSessionId: string,
  cwd: string,
  configDirectory?: string,
) {
  await readOrdinaryLocalVertexHistory(sdkSessionId, cwd, configDirectory);
}
/** Only the cold owner may qualify absence using durable pre-input cancellation. */
export async function readOrdinaryLocalVertexHistory(
  sdkSessionId: string,
  cwd: string,
  configDirectory?: string,
  allowAbsent = false,
) {
  if (configDirectory) {
    const { info, messages } = await readClaudeAccountHistory(sdkSessionId, cwd, configDirectory);
    if (allowAbsent && !info && !messages.length) return false;
    if (!info || info.sessionId !== sdkSessionId || info.cwd !== cwd || !messages.length)
      throw Error('Original SDK history unavailable');
    return true;
  }
  const info = await getSessionInfo(sdkSessionId, { dir: cwd });
  if (!info && allowAbsent) {
    if (!(await getSessionMessages(sdkSessionId, { dir: cwd, limit: 1 })).length) return false;
  }
  if (!info || info.sessionId !== sdkSessionId || info.cwd !== cwd)
    throw Error('Original SDK history unavailable');
  const messages = await getSessionMessages(sdkSessionId, { dir: cwd, limit: 1 });
  if (!messages.length) throw Error('Original SDK history unavailable');
  return true;
}
