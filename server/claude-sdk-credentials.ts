import type { OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';
import { ClaudeSubscriptionCustody } from './claude-subscription-custody.js';
import { AnthropicApiCustody } from './anthropic-api-custody.js';
type Snapshot = OrdinaryLocalVertexCustody['credentialAuthority'];
export async function claudeSdkInferenceEnvironment(
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  if (!env.MITZO_ANTHROPIC_API_CUSTODY) return env;
  return (await AnthropicApiCustody.capture(env).inferenceEnvironment(env, signal)) as Record<
    string,
    string
  >;
}
export function captureClaudeSdkCredentials(env: Readonly<NodeJS.ProcessEnv>) {
  return env.MITZO_ANTHROPIC_API_CUSTODY
    ? AnthropicApiCustody.capture(env)
    : env.MITZO_CLAUDE_EXPECTED_EMAIL
      ? ClaudeSubscriptionCustody.capture(env)
      : VertexAdcCustody.capture(env);
}
export function reopenClaudeSdkCredentials(snapshot: Snapshot, env: Readonly<NodeJS.ProcessEnv>) {
  return 'kind' in snapshot && snapshot.kind === 'anthropic-api-key'
    ? AnthropicApiCustody.reopen(snapshot, env)
    : 'kind' in snapshot
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
  if (credential instanceof ClaudeSubscriptionCustody || credential instanceof AnthropicApiCustody)
    await credential.verify(env, signal);
}
