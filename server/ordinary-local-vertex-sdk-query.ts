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
import { gwsShellGuidance } from './gws-shell.js';
import { TurnCallbacks, type TurnCallbackRunner } from './turn-callbacks.js';
import type { OrdinaryLocalCommandAdmission } from '@mitzo/protocol';
import { assertOrdinaryLocalVertexHistory } from './ordinary-local-vertex-native-history.js';
import { assertClaudeSubscriptionAccount } from './claude-subscription-custody.js';
import { assertOrdinarySynchronousFence } from './ordinary-turn-lifecycle.js';
import type { SdkAgentMessageRuntime } from './sdk-agent-message-runtime.js';
import { createLogger } from './logger.js';
import { sdkQueryRetiredEvent } from './sdk-query-retirement.js';
const log = createLogger('owned-sdk-query');
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
export interface SdkCallbackState {
  retired: boolean;
  completing: boolean;
  callbacks: TurnCallbacks;
  runCallback: TurnCallbackRunner;
}
/** Host-only opaque capture; a forged object cannot name a native query. */
export interface OrdinarySdkQueryControl {
  captureInterruptTarget(): object | undefined;
  interruptIfCurrent(target: object): Promise<boolean>;
}
export function createSdkCallbackState(): SdkCallbackState {
  // SDK terminal evidence must retain uncertainty even when the callback
  // finished before the native result arrived. Later text cannot settle effects.
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  return {
    retired: false,
    completing: false,
    callbacks,
    runCallback: (work) => callbacks.track(work),
  };
}
/** The same effect/settlement boundary for owned and continuous SDK histories. */
export function sdkCallbackOptions(
  options: Options,
  lifetime: SdkHookLifetime,
  current: () => SdkCallbackState,
): Pick<Options, 'hooks' | 'canUseTool'> {
  const hooks = Object.fromEntries(
    Object.entries(options.hooks ?? {}).map(([event, matchers]) => [
      event,
      matchers?.map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.map(
          (hook) =>
            (async (data, id, opts) => {
              const state = current();
              const signal = AbortSignal.any([opts.signal]);
              lifetime.bind(signal, state);
              const refusal = () => ({
                continue: false,
                stopReason: 'This completed SDK query has been retired.',
              });
              if (state.retired) return refusal();
              return state.runCallback(async () => {
                try {
                  const result = await hook(data, id, { ...opts, signal });
                  return state.retired || state.completing ? refusal() : result;
                } catch (error) {
                  if (state.retired) return refusal();
                  throw error;
                }
              });
            }) satisfies HookCallback,
        ),
      })),
    ]),
  );
  const canUseTool: NonNullable<Options['canUseTool']> = async (name, data, opts) => {
    const state = current();
    const signal = AbortSignal.any([opts.signal]);
    lifetime.bind(signal, state);
    const refusal = () => ({
      behavior: 'deny' as const,
      message: 'This completed SDK query has been retired.',
    });
    if (state.retired) return refusal();
    const decide = options.canUseTool;
    if (!decide) return { behavior: 'deny', message: 'Original SDK permission owner unavailable' };
    return state.runCallback(async () => {
      try {
        const result = await decide(name, data, { ...opts, signal });
        return state.retired || state.completing ? refusal() : result;
      } catch (error) {
        if (state.retired) return refusal();
        throw error;
      }
    });
  };
  return { hooks, canUseTool };
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
  /** Trusted ordinary command/source fence, after every awaited SDK account
   * check and immediately before yielding that exact frozen user input. */
  beforeInput?(commandId: string): void;
  adapt(query: Query): T;
  settings(
    selection: OrdinaryLocalCommandAdmission['selection'],
  ): Pick<Options, 'model' | 'thinking' | 'effort'>;
  inputChanged(queue: AsyncQueue<SDKUserMessage>): void;
  peerMessages?(): Pick<SdkAgentMessageRuntime, 'beforeInput' | 'observe'> | undefined;
  mcpServers?(state: {
    retired: boolean;
    completing: boolean;
    runCallback: TurnCallbackRunner;
  }): Options['mcpServers'];
}) {
  let input = owners.input;
  const runs = new AsyncQueue<Query>();
  type State = SdkCallbackState & {
    processClose?: ReturnType<typeof observeOrdinarySdkProcessClose>;
    postTerminalFailure?: unknown;
  };
  const states = new WeakMap<Query, State>();
  const interruptTargets = new WeakMap<
    object,
    { run: Query; state: State; interrupt: Query['interrupt'] }
  >();
  const prompt = async function* (queue: AsyncQueue<SDKUserMessage>, current: () => Query) {
    for await (const message of queue) {
      await owners.authorize(owners.controller.signal);
      if (owners.options.env?.MITZO_CLAUDE_EXPECTED_EMAIL) {
        try {
          assertClaudeSubscriptionAccount(await current().accountInfo(), owners.options.env);
          await owners.authorize(owners.controller.signal);
        } catch (error) {
          owners.controller.abort(error);
          throw error;
        }
      }
      try {
        owners.authorizeSync(owners.controller.signal);
        const state = states.get(current());
        const peerInput = owners
          .peerMessages?.()
          ?.beforeInput(message, !!state && !state.retired && !state.completing, state);
        if (peerInput === false) continue;
        if (owners.beforeInput) {
          const commandId = (message as SDKUserMessage & { mitzoMessageId?: unknown })
            .mitzoMessageId;
          if (typeof commandId === 'string' && /^\S{1,200}$/.test(commandId))
            assertOrdinarySynchronousFence(commandId, () => owners.beforeInput!(commandId));
          else if (peerInput !== true)
            throw Error('Original SDK input command identity unavailable');
        }
      } catch (error) {
        owners.controller.abort(error);
        throw error;
      }
      yield message;
    }
  };
  const create = (selection?: OrdinaryLocalCommandAdmission['selection']) => {
    const state: State = createSdkCallbackState();
    const { hooks, canUseTool } = sdkCallbackOptions(owners.options, owners.lifetime, () => state);
    const cliGuidance =
      '\nThis is the selected local Mac Claude SDK route. Native Bash, Read, Glob and Grep use the existing session permissions. For service tasks, inspect workspace instructions and available local CLI tools before concluding access is unavailable. A missing Sheets MCP tool does not establish that Google Workspace is unavailable.\n' +
      `${gwsShellGuidance()}\n`;
    const systemPrompt = owners.options.systemPrompt;
    const options: Options = {
      ...owners.options,
      // The command owner requires the native stdin acknowledgement before a
      // terminal result can settle its exact FIFO entry. The SDK omits this flag.
      extraArgs: { ...owners.options.extraArgs, 'replay-user-messages': null },
      systemPrompt: Array.isArray(systemPrompt)
        ? [...systemPrompt, cliGuidance]
        : typeof systemPrompt === 'object'
          ? systemPrompt.type === 'custom'
            ? {
                ...systemPrompt,
                prompt: Array.isArray(systemPrompt.prompt)
                  ? [...systemPrompt.prompt, cliGuidance]
                  : systemPrompt.prompt + cliGuidance,
              }
            : { ...systemPrompt, append: (systemPrompt.append ?? '') + cliGuidance }
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
    const native = query({ prompt: prompt(input, () => native), options });
    states.set(native, state);
    return native;
  };
  let native = create();
  const firstQuery = native;
  runs.push(native);
  const close = () => {
    states.get(native)!.retired = true;
    states.get(native)!.callbacks.seal();
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
          const state = states.get(run)!;
          // The consumer correlates input echoes and message starts with its
          // current FIFO command. A terminal/retired query cannot contribute
          // provenance to that successor, even while its stream drains.
          if (state.retired || state.completing || terminal) continue;
          if (event.session_id !== undefined && event.session_id !== owners.sdkSessionId)
            throw Error('Original SDK thread identity changed');
          const queryState = states.get(run)!;
          if (owners.peerMessages?.()?.observe(event, queryState, !queryState.retired)) continue;
          if (event.type === 'result') {
            state.completing = true;
            state.callbacks.seal();
            if (state.callbacks.needsSettlement)
              await state.callbacks.settle(owners.controller.signal);
            await owners.authorize(owners.controller.signal);
            if (state.retired || owners.controller.signal.aborted)
              throw new Error('Completed SDK query retired during callback settlement');
            terminal = true;
          }
          yield event;
        }
      } catch (error) {
        if (!terminal || owners.controller.signal.aborted) throw error;
        const state = states.get(run)!;
        state.postTerminalFailure = error;
        // A proven terminal result stays terminal; retain and diagnose later
        // query closure failures without replacing that outcome or losing successors.
        log.warn('SDK query failed after its terminal result', {
          code: 'sdk_post_terminal_failure',
          stage: 'query_close',
          sdkSessionId: owners.sdkSessionId,
          retired: state.retired,
        });
      }
      // This native iterator has ended; the joined iterator can remain open
      // while waiting for another admitted query on the same SDK history.
      yield sdkQueryRetiredEvent();
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
    captureInterruptTarget() {
      const state = states.get(native)!;
      if (
        owners.controller.signal.aborted ||
        state.retired ||
        state.completing ||
        typeof native.interrupt !== 'function'
      )
        return;
      const target = Object.freeze({});
      interruptTargets.set(target, {
        run: native,
        state,
        interrupt: native.interrupt.bind(native),
      });
      return target;
    },
    async interruptIfCurrent(target: object) {
      const witness = interruptTargets.get(target);
      if (
        !witness ||
        witness.run !== native ||
        witness.state.retired ||
        witness.state.completing ||
        owners.controller.signal.aborted
      )
        return false;
      owners.authorizeSync(owners.controller.signal);
      await witness.interrupt();
      return true;
    },
    push(message: SDKUserMessage) {
      input.push(message);
    },
    async apply(selection: OrdinaryLocalCommandAdmission['selection']) {
      await owners.authorize(owners.controller.signal);
      if (first) {
        first = false;
        return;
      }
      await assertOrdinaryLocalVertexHistory(
        owners.sdkSessionId,
        owners.cwd,
        owners.options.env?.CLAUDE_CONFIG_DIR,
      );
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
