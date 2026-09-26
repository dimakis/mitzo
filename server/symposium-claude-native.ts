import type { ControlledAttemptSandbox } from './symposium-attempt-transport.js';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import type { SymposiumNativeSeat } from './symposium-openshell-seat-executor.js';
import { symposiumSeatRuntimeId, type SymposiumSeatRoute } from './symposium-seat-runtime.js';
import { symposiumSeatSystemPrompt } from './symposium-seat-prompt.js';

type ClaudeRoute = Extract<SymposiumSeatRoute, { kind: 'claude-vertex' }>;

/** Runs inside the sandbox, where OpenShell projects the attached provider's env. */
export const claudeVertexLaunchScript = `
project=$1; region=$2; shift 2
test "\${VERTEX_AI_PROJECT_ID-}" = "$project" || exit 64
test "\${VERTEX_AI_REGION-}" = "$region" || exit 64
token=\${GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN-}
adc_token=\${GOOGLE_VERTEX_AI_TOKEN-}
test -z "$token" || test -z "$adc_token" || exit 64
if test -z "$token"; then
  token=$adc_token
  key=GOOGLE_VERTEX_AI_TOKEN
else
  key=GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN
fi
case "$token" in
  "openshell:resolve:env:$key"|openshell:resolve:env:v[0-9]*_"$key"|"provider-OPENSHELL-RESOLVE-ENV-$key") ;;
  *) exit 64 ;;
esac
unset ANTHROPIC_VERTEX_BASE_URL ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GOOGLE_APPLICATION_CREDENTIALS
export CLAUDE_CODE_USE_VERTEX=1 CLAUDE_CODE_SKIP_VERTEX_AUTH=1
export ANTHROPIC_VERTEX_PROJECT_ID="$project" CLOUD_ML_REGION="$region"
export ANTHROPIC_CUSTOM_HEADERS="Authorization: Bearer $token"
exec "$@"
`;

function privateSessionUuid(input: SymposiumSeatExecution): string {
  const hex = createHash('sha256').update(symposiumSeatRuntimeId(input)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Argv only: the routed user text goes to stdin, never SSH argv or process listings. */
export function claudeVertexArgv(route: ClaudeRoute, input: SymposiumSeatExecution): string[] {
  if (
    !/^[a-z][a-z0-9-]{4,62}$/.test(route.projectId) ||
    !/^[a-z][a-z0-9-]+$/.test(route.region) ||
    !/^claude-[a-z0-9][a-z0-9.-]*(?:@[0-9]{8})?$/.test(route.model)
  )
    throw new Error('Invalid pinned Vertex route');
  return [
    '/bin/sh',
    '-eu',
    '-c',
    claudeVertexLaunchScript,
    '--',
    route.projectId,
    route.region,
    '/usr/local/bin/claude',
    '--print',
    '--bare',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--model',
    route.model,
    ...(route.effort ? ['--effort', route.effort] : []),
    '--tools',
    route.readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
    '--permission-mode',
    route.readOnly ? 'plan' : 'acceptEdits',
    '--append-system-prompt',
    symposiumSeatSystemPrompt(input.seat),
    ...(input.providerThreadId
      ? ['--resume', input.providerThreadId]
      : ['--session-id', privateSessionUuid(input)]),
  ];
}

export type ClaudeVertexEvent =
  | { kind: 'init'; threadId: string }
  | { kind: 'assistant'; threadId: string; turnId: string; text: string }
  | { kind: 'native'; threadId: string; turnId?: string }
  | { kind: 'result'; threadId: string; success: boolean; costUsd?: number };

/** System init alone does not prove the prompt reached the provider. */
export function readClaudeVertexEvent(value: unknown): ClaudeVertexEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const threadId = data.session_id;
  if (typeof threadId !== 'string' || !threadId) return undefined;
  if (data.type === 'system' && data.subtype === 'init') return { kind: 'init', threadId };
  if (data.type === 'stream_event') {
    const event = data.event;
    const stream = event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
    const message = stream.message;
    const id =
      message && typeof message === 'object' ? (message as Record<string, unknown>).id : null;
    return {
      kind: 'native',
      threadId,
      ...(stream.type === 'message_start' && typeof id === 'string' && id ? { turnId: id } : {}),
    };
  }
  if (
    data.type === 'user' ||
    data.type === 'progress' ||
    data.type === 'progress_update' ||
    (typeof data.type === 'string' && data.type.startsWith('subagent_'))
  )
    return { kind: 'native', threadId };
  if (data.type === 'assistant') {
    const message = data.message;
    if (!message || typeof message !== 'object') return undefined;
    const id = (message as Record<string, unknown>).id;
    const blocks = (message as Record<string, unknown>).content;
    if (typeof id !== 'string' || !id || !Array.isArray(blocks)) return undefined;
    const text = blocks
      .filter(
        (block): block is { type: 'text'; text: string } =>
          !!block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('');
    return { kind: 'assistant', threadId, turnId: id, text };
  }
  if (data.type === 'result') {
    const cost = data.total_cost_usd;
    return {
      kind: 'result',
      threadId,
      success: data.is_error === false,
      ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    };
  }
  return undefined;
}

interface ClaudeProcess extends EventEmitter {
  stdin: EventEmitter & { end(data: string): void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface ClaudeVertexSeatInput {
  sandbox: ControlledAttemptSandbox;
  route: ClaudeRoute;
  execution: SymposiumSeatExecution;
  attemptRegistry?: SymposiumAttemptRegistry;
  spawnProcess?: (spec: ReturnType<typeof openShellSshArgvProcessSpec>) => ClaudeProcess;
  onEvent?: (event: Record<string, unknown>) => void;
}

/** Claude runs through the pinned Vertex provider attached to this shared sandbox. */
export async function createClaudeVertexSeat(
  input: ClaudeVertexSeatInput,
): Promise<SymposiumNativeSeat> {
  const { execution, route } = input;
  const argv = claudeVertexArgv(route, execution);
  const expectedThreadId = execution.providerThreadId ?? argv[argv.indexOf('--session-id') + 1];
  const spec = openShellSshArgvProcessSpec(input.sandbox, argv);
  let child: ClaudeProcess | undefined;
  let confirmStopped: (() => Promise<void>) | undefined;
  let terminalConfirmed = false;
  return {
    run(currentExecution, callbacks) {
      if (currentExecution.claimToken !== execution.claimToken)
        throw new Error('Claude native attempt identity changed');
      callbacks.beforeDispatch();
      if (input.spawnProcess) child = input.spawnProcess(spec);
      else {
        if (!input.attemptRegistry) throw new Error('Native attempt registry is unavailable');
        const controlled = input.attemptRegistry.launch({
          sandbox: input.sandbox,
          sessionId: execution.sessionId,
          claimToken: execution.claimToken,
          access: route.readOnly ? 'read' : 'write',
          command: argv,
        });
        child = controlled.child;
        confirmStopped = controlled.confirmStopped;
      }
      const process = child;
      let stdout = '';
      let outputBytes = 0;
      let threadId: string | undefined;
      let accepted = false;
      let result: Extract<ClaudeVertexEvent, { kind: 'result' }> | undefined;
      const texts: string[] = [];
      return new Promise<{ providerThreadId: string; content: string; costUsd?: number }>(
        (resolve, reject) => {
          let settled = false;
          const fail = () => {
            if (settled) return;
            settled = true;
            if (confirmStopped) {
              try {
                input.attemptRegistry?.markUncertain(execution.claimToken);
              } catch {
                // A concurrent exact cancellation may already have confirmed the claim.
              }
            }
            reject(new Error('Claude native turn failed or has an uncertain outcome'));
          };
          process.stdout.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes > 8_000_000) return fail();
            stdout += chunk.toString();
            let newline = stdout.indexOf('\n');
            while (newline >= 0) {
              const line = stdout.slice(0, newline);
              stdout = stdout.slice(newline + 1);
              if (line.length > 1_000_000) return fail();
              let value: unknown;
              try {
                value = JSON.parse(line);
              } catch {
                return fail();
              }
              const event = readClaudeVertexEvent(value);
              if (event) {
                if (
                  event.threadId !== expectedThreadId ||
                  (threadId && threadId !== event.threadId)
                )
                  return fail();
                threadId = event.threadId;
                if (event.kind === 'assistant' || (event.kind === 'native' && event.turnId)) {
                  if (!accepted) {
                    accepted = true;
                    try {
                      callbacks.accepted(event.threadId, event.turnId!);
                    } catch {
                      return fail();
                    }
                  }
                  if (event.kind === 'assistant' && event.text) texts.push(event.text);
                } else if (event.kind === 'result') result = event;
                try {
                  input.onEvent?.(value as Record<string, unknown>);
                } catch {
                  return fail();
                }
              }
              newline = stdout.indexOf('\n');
            }
          });
          process.on('error', fail);
          // The SSH relay may close its pipe before consuming the prompt. Keep
          // this listener after settlement too, so late pipe errors stay handled.
          process.stdin.on('error', fail);
          process.on('close', async (code: number | null) => {
            if (settled) return;
            if (code !== 0 || !result?.success || !threadId || !accepted) return fail();
            try {
              await confirmStopped?.();
            } catch {
              return fail();
            }
            terminalConfirmed = true;
            settled = true;
            resolve({
              providerThreadId: threadId,
              content: texts.join('\n\n'),
              ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
            });
          });
          try {
            process.stdin.end(execution.content);
          } catch {
            fail();
          }
        },
      );
    },
    async cancel() {
      if (!child || terminalConfirmed) return;
      if (confirmStopped) {
        await confirmStopped();
        terminalConfirmed = true;
        return;
      }
      child.kill('SIGTERM');
      // Terminating a host SSH relay does not prove its remote Claude process
      // stopped; retain the durable cleanup reservation for reconciliation.
      throw new Error('Claude native cleanup is unconfirmed');
    },
  };
}
