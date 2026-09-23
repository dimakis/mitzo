import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicVertexModelProvider } from '../src/providers/anthropic-vertex.js';
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mock.create };
  },
}));
vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    messages = { create: mock.create };
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  mock.create.mockReset();
});
it.each(['0', '1'])(
  'forwards cancellation and disables SDK retries on admitted calls (Vertex %s)',
  async (vertex) => {
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', vertex);
    mock.create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const signal = new AbortController().signal;
    await new AnthropicVertexModelProvider('claude-opus-4-6').call([], { signal, maxRetries: 0 });
    expect(mock.create.mock.calls[0][1]).toEqual({ signal, maxRetries: 0 });
  },
);
