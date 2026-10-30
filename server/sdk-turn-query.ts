import { spawn } from 'node:child_process';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createSdkCallbackState,
  sdkCallbackOptions,
  SdkHookLifetime,
  type SdkCallbackState,
} from './ordinary-local-vertex-sdk-query.js';
import { observeOrdinarySdkProcessClose } from './ordinary-local-vertex-sdk-process.js';
import { assertOrdinaryLocalVertexHistory } from './ordinary-local-vertex-native-history.js';
import type { ProtectedSdkProcess } from './credential-sdk-boundary.js';
import { SessionRuntimeError } from './session-runtime-error.js';

/** SDK callbacks carry no trustworthy native turn identity. Each native query
 * therefore owns immutable closures; successors resume the original history
 * only after settlement, terminal delivery and confirmed original process close. */
export function createSdkTurnQuery<T extends AsyncIterable<Record<string, unknown>>>(owners: {
  input: AsyncIterable<SDKUserMessage>;
  controller: AbortController;
  lifetime: SdkHookLifetime;
  sdkSessionId: string;
  cwd: string;
  authorize(signal: AbortSignal): Promise<void>;
  options(state: SdkCallbackState): Options;
  create(request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query;
  adapt(query: Query): T;
  assertHistory?: typeof assertOrdinaryLocalVertexHistory;
  onUnsent?(message: SDKUserMessage, error: SessionRuntimeError): void;
}): T {
  const stopped = new AbortController();
  const signal = AbortSignal.any([owners.controller.signal, stopped.signal]);
  const inputs = owners.input[Symbol.asyncIterator]();
  const nextInput = async () => {
    signal.throwIfAborted();
    let onAbort = () => {};
    try {
      return await Promise.race([
        inputs.next(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  let closed = false;
  let first = true;
  const settings: Partial<Options> = {};
  let unsent: SDKUserMessage | undefined;
  const reportUnsent = (cause: unknown) => {
    const error = new SessionRuntimeError('input_not_dispatched', { cause });
    const message = unsent;
    unsent = undefined;
    if (message) {
      try {
        owners.onUnsent?.(message, error);
      } catch {
        /* Reporting cannot dispatch an input. */
      }
    }
    return error;
  };
  const create = (initial?: SDKUserMessage) => {
    const state = createSdkCallbackState();
    const options = { ...owners.options(state), ...settings };
    let processClose: ReturnType<typeof observeOrdinarySdkProcessClose> | undefined;
    let finishPrompt = () => {};
    const promptFinished = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const prompt = async function* () {
      const input = initial ? { value: initial, done: false } : await nextInput();
      if (input.done) return;
      unsent = input.value;
      try {
        await owners.authorize(signal);
        signal.throwIfAborted();
        if (closed || state.retired) throw new SessionRuntimeError('turn_completed');
      } catch (error) {
        throw reportUnsent(error);
      }
      unsent = undefined;
      yield input.value;
      await promptFinished;
    };
    const native = owners.create({
      prompt: prompt(),
      options: {
        ...options,
        ...(!first ? { sessionId: undefined, resume: owners.sdkSessionId } : {}),
        ...sdkCallbackOptions(options, owners.lifetime, () => state),
        spawnClaudeCodeProcess: (request) => {
          signal.throwIfAborted();
          if (closed || state.retired) throw new SessionRuntimeError('turn_completed');
          const child = options.spawnClaudeCodeProcess
            ? options.spawnClaudeCodeProcess(request)
            : spawn(request.command, request.args, {
                cwd: request.cwd,
                env: request.env,
                signal: request.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
              });
          processClose = observeOrdinarySdkProcessClose(child as ProtectedSdkProcess);
          return child;
        },
      },
    });
    first = false;
    let retired = false;
    return {
      native,
      state,
      retire: () => {
        if (retired) return;
        retired = true;
        state.retired = true;
        state.callbacks.seal();
        finishPrompt();
        native.close();
      },
      wait: async () => {
        if (!processClose) throw new SessionRuntimeError('runtime_unavailable');
        await processClose.wait(signal);
      },
    };
  };
  let current = create();
  let idle = false;
  const close = () => {
    if (closed) return;
    closed = true;
    current.retire();
    stopped.abort(new SessionRuntimeError('turn_completed'));
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  const events = async function* () {
    try {
      while (!closed) {
        let terminal = false;
        let terminalFailed = false;
        for await (const event of owners.adapt(current.native)) {
          if (event.session_id !== undefined && event.session_id !== owners.sdkSessionId)
            throw new SessionRuntimeError('provider_identity');
          if (event.type !== 'result') {
            yield event;
            continue;
          }
          current.state.completing = true;
          await current.state.callbacks.settle(signal);
          await owners.authorize(signal);
          signal.throwIfAborted();
          if (current.state.retired) throw new SessionRuntimeError('turn_completed');
          terminal = true;
          terminalFailed = event.is_error === true;
          idle = true;
          yield event;
          break;
        }
        if (closed) break;
        if (!terminal) throw new SessionRuntimeError('runtime_unavailable');
        if (terminalFailed) return;
        idle = true;
        current.retire();
        await current.wait();
        const input = await nextInput();
        if (closed || input.done) break;
        unsent = input.value;
        await (owners.assertHistory ?? assertOrdinaryLocalVertexHistory)(
          owners.sdkSessionId,
          owners.cwd,
        );
        await owners.authorize(signal);
        signal.throwIfAborted();
        if (closed) break;
        current = create(input.value);
        idle = false;
      }
    } catch (error) {
      if (unsent) throw reportUnsent(error);
      if (!closed || owners.controller.signal.aborted) throw error;
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  };
  return new Proxy(owners.adapt(current.native), {
    get(_target, property) {
      if (property === Symbol.asyncIterator) return events;
      if (property === 'close') return close;
      if (property === 'interrupt')
        return async () => {
          signal.throwIfAborted();
          if (closed) throw new SessionRuntimeError('turn_completed');
          if (!idle) {
            const run = current;
            await run.state.runCallback(() => run.native.interrupt());
          }
        };
      if (['setModel', 'setPermissionMode', 'setMaxThinkingTokens'].includes(String(property)))
        return async (value: unknown) => {
          signal.throwIfAborted();
          if (closed) throw new SessionRuntimeError('turn_completed');
          const apply = async () => {
            if (!idle) {
              const adapted = owners.adapt(current.native);
              const control: unknown = Reflect.get(adapted, property, adapted);
              if (typeof control !== 'function')
                throw new SessionRuntimeError('runtime_unavailable');
              await control.call(adapted, value);
            }
            if (property === 'setModel') settings.model = value as string | undefined;
            else if (property === 'setPermissionMode')
              settings.permissionMode = value === 'ask' ? 'plan' : 'default';
            else {
              settings.maxThinkingTokens = typeof value === 'number' ? value : undefined;
              settings.thinking = undefined;
            }
          };
          if (idle) await apply();
          else await current.state.runCallback(apply);
        };
      const adapted = owners.adapt(current.native);
      const value: unknown = Reflect.get(adapted, property, adapted);
      return typeof value === 'function' ? value.bind(adapted) : value;
    },
  });
}
