import { expect, it, vi } from 'vitest';
import { AsyncQueue } from '../async-queue.js';
import { createContinuousSdkQuery } from '../continuous-sdk-callbacks.js';
import { SdkHookLifetime } from '../ordinary-local-vertex-sdk-query.js';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

it('keeps one SDK query/history and gates its next input until original callbacks and result delivery settle', async () => {
  const inputs = new AsyncQueue<SDKUserMessage>();
  const events = new AsyncQueue<Record<string, unknown>>();
  let prompt!: AsyncIterator<SDKUserMessage>;
  let options!: Options;
  const create = vi.fn((request) => {
    prompt = request.prompt[Symbol.asyncIterator]();
    options = request.options;
    return { close: vi.fn(), [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() };
  });
  const controller = new AbortController();
  let finish!: () => void;
  const permission = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { behavior: 'allow', updatedInput: {} };
  });
  const q = createContinuousSdkQuery({
    input: inputs,
    controller,
    lifetime: new SdkHookLifetime(),
    authorize: async () => {},
    options: () => ({ resume: 'retained-history', canUseTool: permission as never }),
    create: create as never,
    adapt: (query) => query as never,
  });
  inputs.push({ message: { role: 'user', content: 'first' } } as never);
  await prompt.next();
  const callback = options.canUseTool!('Bash', {}, {
    signal: controller.signal,
    toolUseID: 'first-tool',
  } as never);
  await vi.waitFor(() => expect(finish).toBeDefined());
  inputs.push({ message: { role: 'user', content: 'second' } } as never);
  let delivered = false;
  const nextInput = prompt.next().then((input) => {
    delivered = true;
    return input;
  });
  const output = q[Symbol.asyncIterator]();
  events.push({ type: 'result' });
  const terminal = output.next();
  await new Promise((resolve) => setImmediate(resolve));
  expect(delivered).toBe(false);
  finish();
  expect(await callback).toMatchObject({ behavior: 'deny' });
  expect((await terminal).value).toMatchObject({ type: 'result' });
  expect(delivered).toBe(false);
  const waiting = output.next();
  expect((await nextInput).value).toMatchObject({ message: { content: 'second' } });
  expect(create).toHaveBeenCalledOnce();
  expect(options.resume).toBe('retained-history');
  events.close();
  await waiting;
  controller.abort();
});
