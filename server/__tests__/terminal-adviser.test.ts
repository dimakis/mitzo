import { acquireFeatureInference } from '../feature-inference-admission.js';
import { it, expect, vi } from 'vitest';
import { TerminalAdviser, TextAdviser, AdviserBody } from '../terminal-adviser.js';

it('shares inference admission across distinct adviser instances and releases on cancellation', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = vi.fn(async () => ({
    provider: 'fake',
    async *turn() {
      await held;
      yield {
        type: 'content_block_delta' as const,
        index: 0,
        delta: { type: 'text_delta' as const, text: 'done' },
      };
    },
  }));
  const request = {
    accountId: 'shared-account',
    model: 'luna',
    messages: [{ role: 'user' as const, content: 'review' }],
  };
  const first = new TextAdviser(factory, 'one').ask('same-owner', request, controller.signal);
  try {
    await expect(
      new TextAdviser(factory, 'two').ask('same-owner', request, controller.signal),
    ).rejects.toThrow('busy');
    expect(factory).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    release();
  }
  await expect(first).rejects.toThrow();
  await expect(
    new TextAdviser(factory, 'three').ask('same-owner', request, new AbortController().signal),
  ).resolves.toMatchObject({ text: 'done' });
});
it('sends only deliberately supplied context with no tools and never executes suggestions', async () => {
  const factory = vi.fn(async (_config) => ({
    provider: 'fake',
    async *turn(messages: unknown) {
      expect(messages).toEqual([
        { role: 'user', content: 'Explain this\n\nReviewed terminal output:\npermission denied' },
      ]);
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Try checking permissions.\n```sh\nls -la\n```' },
      };
    },
  }));
  const adviser = new TerminalAdviser(factory as never);
  const result = await adviser.ask(
    'owner',
    {
      accountId: 'work',
      model: 'luna',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'Explain this' }],
      output: 'permission denied',
    },
    new AbortController().signal,
  );
  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ tools: [], model: 'luna', reasoningEffort: 'low' }),
    expect.objectContaining({ accountId: 'work' }),
  );
  expect(result.commands).toEqual(['ls -la']);
  expect(result.text).toContain('permissions');
});
it('fails closed if a provider emits a tool call, with no execution handler available', async () => {
  const adviser = new TerminalAdviser(async () => ({
    provider: 'fake',
    async *turn() {
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'x',
          name: 'shell',
          input: { command: 'touch /tmp/bad' },
        },
      };
    },
  }));
  await expect(
    adviser.ask(
      'owner',
      { accountId: 'work', model: 'luna', messages: [{ role: 'user', content: 'help' }] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('tools');
});
it('rejects implicit output sharing, executable objects and oversized history', () => {
  expect(
    AdviserBody.safeParse({
      accountId: 'work',
      model: 'luna',
      messages: [{ role: 'user', content: 'help' }],
      terminalSnapshot: true,
    }).success,
  ).toBe(false);
  expect(
    AdviserBody.safeParse({
      accountId: 'work',
      model: 'luna',
      messages: [{ role: 'tool', content: 'help' }],
    }).success,
  ).toBe(false);
  expect(
    AdviserBody.safeParse({
      accountId: 'work',
      model: 'luna',
      messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'help' })),
    }).success,
  ).toBe(false);
});

it('keeps multiline commands reviewable and rejects invisible terminal control sequences', async () => {
  const adviser = new TerminalAdviser(async () => ({
    provider: 'fake',
    async *turn() {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: '```sh\necho first\npwd\n```\n```sh\necho safe\rHIDDEN\n```',
        },
      };
    },
  }));
  const result = await adviser.ask(
    'owner',
    { accountId: 'work', model: 'luna', messages: [{ role: 'user', content: 'help' }] },
    new AbortController().signal,
  );
  expect(result.commands).toEqual(['echo first\npwd']);
});

it('bounds live capacity by account and process and releases leases idempotently', () => {
  const signal = new AbortController().signal;
  const releases: Array<() => void> = [];
  try {
    releases.push(acquireFeatureInference('quota-a', 'quota-account', signal));
    releases.push(acquireFeatureInference('quota-b', 'quota-account', signal));
    expect(() => acquireFeatureInference('quota-c', 'quota-account', signal)).toThrow('busy');
    for (let i = 0; i < 18; i++)
      releases.push(acquireFeatureInference(`global-${i}`, `account-${i}`, signal));
    expect(() => acquireFeatureInference('global-extra', 'other-account', signal)).toThrow('busy');
    releases[0]!();
    releases[0]!();
    releases.push(acquireFeatureInference('quota-c', 'quota-account', signal));
  } finally {
    for (const release of releases) release();
  }
});
