import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createSdkCallbackState,
  sdkCallbackOptions,
  SdkHookLifetime,
  type SdkCallbackState,
} from './ordinary-local-vertex-sdk-query.js';

/** Retains one native SDK query/history. Only explicit input delivery and host
 * callback lifetimes are coordinated; account, settings and resume stay with the caller. */
export function createContinuousSdkQuery<T extends AsyncIterable<Record<string, unknown>>>(owners: {
  input: AsyncIterable<SDKUserMessage>;
  controller: AbortController;
  lifetime: SdkHookLifetime;
  authorize(signal: AbortSignal): Promise<void>;
  options(state: SdkCallbackState): Options;
  create(request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query;
  adapt(query: Query): T;
}): T {
  let current = createSdkCallbackState();
  let released = Promise.resolve();
  let release = () => {};
  let first = true;
  let closed = false;
  const signal = owners.controller.signal;
  const view: SdkCallbackState = {
    get retired() {
      return current.retired;
    },
    set retired(value) {
      current.retired = value;
    },
    get completing() {
      return current.completing;
    },
    set completing(value) {
      current.completing = value;
    },
    get callbacks() {
      return current.callbacks;
    },
    runCallback: (work) => current.runCallback(work),
  };
  const prompt = async function* () {
    for await (const message of owners.input) {
      await released;
      signal.throwIfAborted();
      if (closed) throw Error('SDK input owner is closed');
      if (!first) current = createSdkCallbackState();
      first = false;
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await owners.authorize(signal);
      signal.throwIfAborted();
      yield message;
    }
  };
  const options = owners.options(view);
  const native = owners.create({
    prompt: prompt(),
    options: { ...options, ...sdkCallbackOptions(options, owners.lifetime, () => current) },
  });
  const adapted = owners.adapt(native);
  const close = () => {
    if (closed) return;
    closed = true;
    current.retired = true;
    current.callbacks.seal();
    release();
    native.close();
  };
  signal.addEventListener('abort', close, { once: true });
  const events = async function* () {
    try {
      for await (const event of adapted) {
        if (event.type !== 'result') {
          yield event;
          continue;
        }
        const state = current;
        state.completing = true;
        await state.callbacks.settle(signal);
        await owners.authorize(signal);
        signal.throwIfAborted();
        if (state !== current || state.retired)
          throw Error('SDK callback owner retired during completion');
        yield event;
        state.retired = true;
        release();
      }
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  };
  return new Proxy(adapted, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return events;
      if (property === 'close') return close;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
