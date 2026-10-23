import { observeOrdinarySdkProcessClose } from './ordinary-local-vertex-sdk-process.js';
import type { ProtectedSdkProcess } from './credential-sdk-boundary.js';
import {
  query,
  type Query,
  type SDKUserMessage,
  type Options,
  type HookCallback,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './async-queue.js';
import type { OrdinaryLocalCommandAdmission } from '@mitzo/protocol';
import { assertOrdinaryLocalVertexHistory } from './ordinary-local-vertex-native-history.js';
/** Only the lifetime of an SDK query, not runtime/auth/history state. Retiring a
 * completed query cannot abort its successor; stale hooks always refuse effects. */
export class SdkHookLifetime {
  readonly #signals = new WeakMap<AbortSignal, { retired: boolean }>();
  bind(signal: AbortSignal, state: { retired: boolean }) {
    this.#signals.set(signal, state);
  }
  propagate(source: AbortSignal, target: AbortSignal) {
    const state = this.#signals.get(source);
    if (state) this.#signals.set(target, state);
  }
  retired(signal: AbortSignal) {
    return this.#signals.get(signal)?.retired === true;
  }
}
/** Reuses the existing ManagedSession/query-loop by joining native query
 * instances. Every successor resumes the same SDK history after a terminal result. */
export function createOrdinaryLocalVertexSdkQuery<
  T extends AsyncIterable<Record<string, unknown>>,
>(owners: {
  options: Options;
  input: AsyncQueue<SDKUserMessage>;
  lifetime: SdkHookLifetime;
  sdkSessionId: string;
  cwd: string;
  controller: AbortController;
  authorize(signal: AbortSignal): Promise<void>;
  authorizeSync(signal: AbortSignal): void;
  adapt(query: Query): T;
  settings(
    selection: OrdinaryLocalCommandAdmission['selection'],
  ): Pick<Options, 'model' | 'thinking' | 'effort'>;
  inputChanged(queue: AsyncQueue<SDKUserMessage>): void;
  mcpServers?(state: { retired: boolean }): Options['mcpServers'];
}) {
  let input = owners.input;
  const runs = new AsyncQueue<Query>();
  type State = {
    retired: boolean;
    processClose?: ReturnType<typeof observeOrdinarySdkProcessClose>;
  };
  const states = new WeakMap<Query, State>();
  const prompt = async function* (queue: AsyncQueue<SDKUserMessage>) {
    for await (const message of queue) {
      await owners.authorize(owners.controller.signal);
      yield message;
    }
  };
  const create = (selection?: OrdinaryLocalCommandAdmission['selection']) => {
    const state: State = { retired: false };
    const hooks = Object.fromEntries(
      Object.entries(owners.options.hooks ?? {}).map(([event, matchers]) => [
        event,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map(
            (hook) =>
              (async (data, id, opts) => {
                const signal = AbortSignal.any([opts.signal]);
                owners.lifetime.bind(signal, state);
                const refusal = () => ({
                  continue: false,
                  stopReason: 'This completed SDK query has been retired.',
                });
                if (state.retired) return refusal();
                try {
                  const result = await hook(data, id, { ...opts, signal });
                  return state.retired ? refusal() : result;
                } catch (error) {
                  if (state.retired) return refusal();
                  throw error;
                }
              }) satisfies HookCallback,
          ),
        })),
      ]),
    );
    const canUseTool: NonNullable<Options['canUseTool']> = async (name, data, opts) => {
      const signal = AbortSignal.any([opts.signal]);
      owners.lifetime.bind(signal, state);
      const refusal = () => ({
        behavior: 'deny' as const,
        message: 'This completed SDK query has been retired.',
      });
      if (state.retired) return refusal();
      if (!owners.options.canUseTool)
        return { behavior: 'deny', message: 'Original SDK permission owner unavailable' };
      try {
        const result = await owners.options.canUseTool(name, data, { ...opts, signal });
        return state.retired ? refusal() : result;
      } catch (error) {
        if (state.retired) return refusal();
        throw error;
      }
    };
    const cliGuidance =
      '\nThis is the selected local Mac Claude SDK route. Native Bash, Read, Glob and Grep use the existing session permissions. For service tasks, inspect workspace instructions and available local CLI tools before concluding access is unavailable. For Google Workspace, check command -v gws and gws --help with Bash; a missing Sheets MCP tool does not establish that the local CLI is unavailable. CLI presence does not establish authentication: try only the authorized service read and report its actual result. Do not run gws auth login or search for credentials to repair access.\n';
    const systemPrompt = owners.options.systemPrompt;
    const options: Options = {
      ...owners.options,
      // The command owner requires the native stdin acknowledgement before a
      // terminal result can settle its exact FIFO entry. The SDK omits this flag.
      extraArgs: { ...owners.options.extraArgs, 'replay-user-messages': null },
      systemPrompt: Array.isArray(systemPrompt)
        ? [...systemPrompt, cliGuidance]
        : typeof systemPrompt === 'object'
          ? { ...systemPrompt, append: (systemPrompt.append ?? '') + cliGuidance }
          : (systemPrompt ?? '') + cliGuidance,
      hooks,
      canUseTool,
      ...(owners.options.spawnClaudeCodeProcess
        ? {
            spawnClaudeCodeProcess: (input) => {
              if (state.retired) throw Error('Completed SDK query retired');
              owners.authorizeSync(input.signal);
              const process = owners.options.spawnClaudeCodeProcess!(input);
              state.processClose = observeOrdinarySdkProcessClose(process as ProtectedSdkProcess);
              return process;
            },
          }
        : {}),
      ...(owners.mcpServers ? { mcpServers: owners.mcpServers(state) } : {}),
      ...(selection
        ? { ...owners.settings(selection), sessionId: undefined, resume: owners.sdkSessionId }
        : {}),
    };
    if (selection) delete options.sessionId;
    const native = query({ prompt: prompt(input), options });
    states.set(native, state);
    return native;
  };
  let native = create();
  const firstQuery = native;
  runs.push(native);
  const close = () => {
    input.close();
    runs.close();
    native.close();
  };
  owners.controller.signal.addEventListener('abort', close, { once: true });
  const events = async function* () {
    for await (const run of runs) {
      let terminal = false;
      try {
        for await (const event of owners.adapt(run)) {
          if (event.session_id !== undefined && event.session_id !== owners.sdkSessionId)
            throw Error('Original SDK thread identity changed');
          if (event.type === 'result') terminal = true;
          yield event;
        }
      } catch (error) {
        if (!terminal || owners.controller.signal.aborted) throw error;
      }
    }
  };
  const joined = new Proxy(owners.adapt(native), {
    get(_target, property) {
      if (property === Symbol.asyncIterator) return events;
      if (property === 'close') return close;
      const current = owners.adapt(native),
        value: unknown = Reflect.get(current, property, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  let first = true;
  return {
    query: joined,
    firstQuery,
    push(message: SDKUserMessage) {
      input.push(message);
    },
    async apply(selection: OrdinaryLocalCommandAdmission['selection']) {
      await owners.authorize(owners.controller.signal);
      if (first) {
        first = false;
        return;
      }
      await assertOrdinaryLocalVertexHistory(owners.sdkSessionId, owners.cwd);
      await owners.authorize(owners.controller.signal);
      const state = states.get(native)!;
      state.retired = true;
      input.close();
      native.close();
      if (owners.options.spawnClaudeCodeProcess) {
        if (!state.processClose) throw Error('Original SDK process closure unavailable');
        await state.processClose.wait(owners.controller.signal);
      }
      await owners.authorize(owners.controller.signal);
      owners.authorizeSync(owners.controller.signal);
      input = new AsyncQueue<SDKUserMessage>();
      owners.inputChanged(input);
      native = create(selection);
      runs.push(native);
      await owners.authorize(owners.controller.signal);
    },
  };
}
