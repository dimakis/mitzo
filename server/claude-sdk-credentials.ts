import type { OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';
import { ClaudeSubscriptionCustody } from './claude-subscription-custody.js';
type Snapshot = OrdinaryLocalVertexCustody['credentialAuthority'];
export function captureClaudeSdkCredentials(env: Readonly<NodeJS.ProcessEnv>) {
  return env.MITZO_CLAUDE_EXPECTED_EMAIL
    ? ClaudeSubscriptionCustody.capture(env)
    : VertexAdcCustody.capture(env);
}
export function reopenClaudeSdkCredentials(snapshot: Snapshot, env: Readonly<NodeJS.ProcessEnv>) {
  return 'kind' in snapshot
    ? ClaudeSubscriptionCustody.reopen(snapshot, env)
    : VertexAdcCustody.reopen(snapshot, env);
}
export async function verifyClaudeSdkCredentials(
  credential: ReturnType<typeof captureClaudeSdkCredentials>,
  env: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  credential.assertCurrent(env);
  if (credential instanceof ClaudeSubscriptionCustody) await credential.verify(env, signal);
}
