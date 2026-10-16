import { expect, it, vi } from 'vitest';
import { AgentLibraryAdviser, AgentAdviceBody } from '../agent-library-adviser.js';

const definition = {
  name: 'Ada',
  descriptor: 'Research partner',
  role: 'agent',
  instructions: 'Compare sources.',
  expectedOutput: 'Evidence brief',
  acceptanceCriteria: ['Cite sources'],
  modelPolicyRole: 'agent',
};
const input = {
  accountId: 'work',
  model: 'luna',
  reasoningEffort: 'low',
  messages: [{ role: 'user' as const, content: 'Help me create a researcher' }],
  draft: JSON.stringify({ ...definition, name: '' }),
};
it('advises on an incomplete draft without tools or saving, returning a validated proposal', async () => {
  const factory = vi.fn(async () => ({
    provider: 'fake',
    async *turn(messages: { content: string }[]) {
      expect(messages.at(-1)?.content).toContain(input.draft);
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: `Here is a research partner.\n\n\`\`\`json\n${JSON.stringify(definition)}\n\`\`\``,
        },
      };
    },
  }));
  const adviser = new AgentLibraryAdviser(factory as never);
  const result = await adviser.ask('owner', input, new AbortController().signal);
  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'luna',
      reasoningEffort: 'low',
      tools: [],
      systemPrompt: expect.stringContaining('agent profile'),
    }),
    expect.objectContaining({ accountId: 'work' }),
  );
  expect(result).toEqual({ text: 'Here is a research partner.', proposal: definition });
});
it('does not offer invalid or privileged generated profiles for application', async () => {
  const adviser = new AgentLibraryAdviser(async () => ({
    provider: 'fake',
    async *turn() {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: `\`\`\`json\n${JSON.stringify({ ...definition, accountId: 'other' })}\n\`\`\``,
        },
      };
    },
  }));
  const result = await adviser.ask('owner', input, new AbortController().signal);
  expect(result.proposal).toBeUndefined();
});
it('requires an explicit account/model and bounds the draft and history', () => {
  expect(AgentAdviceBody.safeParse(input).success).toBe(true);
  expect(AgentAdviceBody.safeParse({ ...input, model: '' }).success).toBe(false);
  expect(AgentAdviceBody.safeParse({ ...input, draft: 'x'.repeat(32769) }).success).toBe(false);
  expect(AgentAdviceBody.safeParse({ ...input, output: 'terminal data' }).success).toBe(false);
});

it('does not start inference after cancellation during session preparation', async () => {
  let prepared!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = vi.fn(async function* () {
    yield {
      type: 'content_block_delta' as const,
      index: 0,
      delta: { type: 'text_delta' as const, text: 'Must not start' },
    };
  });
  const adviser = new AgentLibraryAdviser(async () => {
    prepared();
    await waiting;
    return { provider: 'fake', turn };
  });
  const controller = new AbortController();
  const cancelled = expect(adviser.ask('owner', input, controller.signal)).rejects.toThrow(
    /abort/i,
  );
  await ready;
  controller.abort();
  release();
  await cancelled;
  expect(turn).not.toHaveBeenCalled();
});

it('includes only the real catalog in advisor context and preserves omitted tool selections', async () => {
  const tools = [{ id: 'mitzo:Read', version: 1 }];
  const adviser = new AgentLibraryAdviser(async () => ({
    provider: 'fake',
    async *turn(messages) {
      expect(messages.at(-1)?.content).toContain('mitzo:Read');
      expect(messages.at(-1)?.content).toContain('Available tool references');
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `\`\`\`json\n${JSON.stringify(definition)}\n\`\`\`` },
      };
    },
  }));
  const result = await adviser.ask(
    'owner',
    { ...input, draft: JSON.stringify({ ...definition, tools }) },
    new AbortController().signal,
  );
  expect(result.proposal?.tools).toEqual(tools);
});
