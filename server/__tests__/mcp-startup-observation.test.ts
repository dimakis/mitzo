import { createHash } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { connectCodexMcpTools } from '../codex-mcp-tools.js';
import { tracer } from '../tracing.js';

const pending = vi.hoisted(() => ({ initialize: Promise.resolve() }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  DEFAULT_INHERITED_ENV_VARS: [],
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class {
    async start() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(transport: { start(): Promise<void> }) {
      await transport.start();
      await pending.initialize;
    }
    async listTools() {
      return { tools: [] };
    }
    async close() {}
  },
}));
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());

it('separates process startup from the MCP handshake without exposing launch configuration', async () => {
  let initialized!: () => void;
  pending.initialize = new Promise((resolve) => {
    initialized = resolve;
  });
  const opening = connectCodexMcpTools(
    { 'private-alias': { command: '/private/connector', args: ['private-token'] } },
    {
      cwd: '/private/workspace',
      env: { SECRET: 'private-secret' },
      signal: new AbortController().signal,
    },
  );
  void opening.catch(() => {});
  try {
    await vi.waitFor(() =>
      expect(exporter.getFinishedSpans().map((span) => span.name)).toContain('mcp.startup.spawn'),
    );
    expect(exporter.getFinishedSpans().map((span) => span.name)).not.toContain(
      'mcp.startup.initialize',
    );
  } finally {
    initialized();
  }
  const tools = await opening;
  await tools.close();
  const spans = exporter.getFinishedSpans();
  const sourceId = createHash('sha256').update('private-alias').digest('hex').slice(0, 16);
  expect(spans.map((span) => span.name)).toEqual(
    expect.arrayContaining([
      'mcp.startup.spawn',
      'mcp.startup.initialize',
      'mcp.startup.connect',
      'mcp.startup.list_tools',
    ]),
  );
  expect(spans.every((span) => span.attributes['mcp.source.id'] === sourceId)).toBe(true);
  expect(
    JSON.stringify(spans.map((span) => [span.attributes, span.events, span.status])),
  ).not.toMatch(/private-alias|private-token|private-secret|\/private/);
});

it('keeps startup and peer cleanup working when the tracing provider throws', async () => {
  const starting = vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
    throw Error('broken exporter');
  });
  const close = vi.fn(async () => {});
  try {
    const tools = await connectCodexMcpTools(
      { synthetic: { command: 'unused' } },
      {
        cwd: '/synthetic',
        env: {},
        signal: new AbortController().signal,
        connect: async () => ({
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({}),
          close,
        }),
      },
    );
    await tools.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    starting.mockRestore();
  }
});
