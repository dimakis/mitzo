import type { ManagedSession } from '@mitzo/harness';
import { agentMessagePrompt, type AgentMessage } from '@mitzo/protocol';
import type { AuthSession } from './auth.js';
import type { CodexConversation } from './codex-conversation.js';

/** Only an initially idle owner may use ordinary admission. A captured active
 * turn becoming stale must never turn a correction into a future command. */
export async function steerNativeAgentMessage(
  runtime: CodexConversation | undefined,
  message: AgentMessage,
  assertCurrent: () => void,
): Promise<'accepted' | 'rejected' | 'uncertain' | 'inactive'> {
  assertCurrent();
  if (!runtime) return 'rejected';
  const state = runtime.peerMessageState();
  if (state === 'idle') return 'inactive';
  if (state !== 'busy') return 'rejected';
  const target = runtime.captureInterruptTarget();
  if (!target) return 'rejected';
  const result = await runtime.steer(
    {
      requestId: message.commandId,
      targetCommandId: target.commandId,
      text: agentMessagePrompt(message),
    },
    assertCurrent,
  );
  return result.status === 'stale_target' ? 'rejected' : result.status;
}

export type AgentMessageDelivery = 'accepted' | 'queued' | 'rejected' | 'uncertain' | 'inactive';
export interface AgentMessageRuntime {
  /** Existing admitted ordinary owner, never a viewer or a peer-supplied identity. */
  identity: object;
  runtime: string;
  assertCurrent(operatorAuthSessionId: string): void;
  state(): 'busy' | 'idle' | 'stopped' | 'preparing';
  steer(
    message: AgentMessage,
    assertCurrent: () => void,
    signal: AbortSignal,
  ): Promise<AgentMessageDelivery>;
  enqueue?(
    message: AgentMessage,
    assertCurrent: () => void,
    signal: AbortSignal,
    auth: AuthSession,
  ): Promise<AgentMessageDelivery>;
}

const runtimes = new WeakMap<ManagedSession, AgentMessageRuntime>();
export function hasAgentMessageRuntime(session: ManagedSession) {
  return runtimes.has(session);
}

/** Host-only runtime registration. It conveys no auth, tool, credential or work grant. */
export function registerAgentMessageRuntime(session: ManagedSession, runtime: AgentMessageRuntime) {
  if (runtimes.has(session)) throw Error('Agent message runtime already registered');
  runtimes.set(session, runtime);
  const release = () => {
    if (runtimes.get(session) === runtime) runtimes.delete(session);
    session.abortController.signal.removeEventListener('abort', release);
  };
  session.abortController.signal.addEventListener('abort', release, { once: true });
  if (session.abortController.signal.aborted) release();
  return release;
}

export function agentMessageRuntime(session: ManagedSession, operator: string) {
  const runtime = runtimes.get(session);
  if (!runtime) return undefined;
  const owner = session.ordinaryRuntimeOwner;
  if (
    session.abortController.signal.aborted ||
    owner?.identity !== runtime.identity ||
    owner.authSessionId !== operator
  )
    throw new AgentCommunicationError(
      'recipient_owner_changed',
      'authorization',
      'The original recipient owner is unavailable.',
    );
  try {
    runtime.assertCurrent(operator);
  } catch (cause) {
    throw new AgentCommunicationError(
      'recipient_authority_unavailable',
      'authorization',
      'The recipient runtime authority is no longer current.',
      { cause },
    );
  }
  return runtime;
}

export class AgentCommunicationError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentCommunicationError';
  }
}

/** Public diagnostic fields are bounded constants; private provider errors stay internal. */
export function agentCommunicationDiagnostic(error: unknown) {
  return error instanceof AgentCommunicationError
    ? { code: error.code, stage: error.stage, message: error.message }
    : {
        code: 'agent_communication_unavailable',
        stage: 'authorization_or_delivery',
        message:
          'Agent communication is unavailable. Inspect the original message receipt before retrying.',
      };
}
