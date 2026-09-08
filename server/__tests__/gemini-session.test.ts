import { afterEach, expect, it, vi } from 'vitest';
import { GeminiSession } from '../gemini-session.js';
import type { ConversationMessage } from '@mitzo/harness';
const config = {
  model: 'gemini-3.8-flash',
  systemPrompt: 'Help',
  maxTokens: 1024,
  tools: [{ name: 'Read', description: 'Read file', input_schema: { type: 'object' } }],
};
const options = {
  accountId: 'work-google',
  projectId: 'work-project',
  region: 'global',
  getAccessToken: async () => 'private-token',
};
async function collect(session: GeminiSession, messages: ConversationMessage[]) {
  const events = [];
  for await (const e of session.turn(messages)) events.push(e);
  return events;
}
afterEach(() => vi.unstubAllGlobals());
it('uses the explicit Vertex route and preserves signed tool calls across restart', async () => {
  const requests: {
    tools: { functionDeclarations: { name: string }[] }[];
    contents: { parts: { thoughtSignature?: string; functionResponse: { response: unknown } }[] }[];
  }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const name = body.tools[0].functionDeclarations[0].name;
    return Response.json({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts:
              requests.length === 1
                ? [
                    {
                      functionCall: { name, args: { path: 'note' } },
                      thoughtSignature: 'signed-private-state',
                    },
                  ]
                : [{ text: 'Done' }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const session = new GeminiSession(config, options);
  const first = await collect(session, [{ role: 'user', content: 'Read note' }]);
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://aiplatform.googleapis.com/v1/projects/work-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent',
  );
  const tool = first.find(
    (e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use',
  );
  expect(tool).toMatchObject({ content_block: { type: 'tool_use', name: 'Read' } });
  expect(JSON.stringify(first)).not.toContain('signed-private-state');
  const checkpoint = session.checkpoint();
  if (tool?.type !== 'content_block_start' || tool.content_block.type !== 'tool_use')
    throw new Error('Missing tool call');
  const id = tool.content_block.id;
  const resumed = new GeminiSession(config, { ...options, checkpoint });
  await collect(resumed, [
    ...checkpoint.history,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'note contents' }] },
  ]);
  expect(requests[1].contents[1].parts[0].thoughtSignature).toBe('signed-private-state');
  expect(requests[1].contents[2].parts[0].functionResponse.response).toEqual({
    output: 'note contents',
  });
  expect(resumed.checkpoint().history.at(-1)).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'Done' }],
  });
  expect(() => new GeminiSession(config, { ...options, accountId: 'other', checkpoint })).toThrow(
    /checkpoint/,
  );
});
it('rejects incomplete or blocked output without checkpointing or emitting tool calls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [] } }],
      }),
    ),
  );
  const session = new GeminiSession(config, options);
  await expect(collect(session, [{ role: 'user', content: 'Hi' }])).rejects.toThrow(/complete/);
  expect(session.checkpoint().history).toEqual([]);
});
