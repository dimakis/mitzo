import { expect, it, vi } from 'vitest';
import { createIntegrationToolDiscovery } from '../integration-tool-discovery.js';
import { credentialConnectionToolDefinitions } from '../credential-connection-tools.js';

const signal = () => new AbortController().signal;
const fixtures = (count = 63) =>
  Array.from({ length: count }, (_, index) => ({
    name: `wire_${index}`,
    description: `mcp__jira__operation_${index}: Search issue ${index}. ${'detail '.repeat(100)}`,
    input_schema: {
      type: 'object',
      properties: {
        [`schema_only_${index}`]: { type: 'string', description: 'Full argument contract' },
      },
    },
  }));
function setup() {
  const tools = fixtures();
  const execute = vi.fn(async () => ({ content: 'approved peer result', isError: false }));
  const assertCurrent = vi.fn();
  return {
    tools,
    execute,
    assertCurrent,
    discovery: createIntegrationToolDiscovery({
      tools,
      displayName: (id) => `mcp__jira__operation_${id.slice(5)}`,
      assertCurrent,
      execute,
    }),
  };
}

it('starts with a small integration index and retrieves paginated summaries without argument schemas', async () => {
  const { discovery, execute } = setup();
  expect(discovery.definitions.map((tool) => tool.name)).toEqual([
    'ListIntegrationTools',
    'DescribeIntegrationTool',
    'InvokeIntegrationTool',
  ]);
  expect(discovery.instructions).toContain('jira (63)');
  const initial = JSON.stringify(discovery.definitions) + discovery.instructions;
  expect(initial.length).toBeLessThan(5000);
  expect(initial).not.toContain('schema_only_');
  const result = await discovery.execute('ListIntegrationTools', { limit: 5, offset: 5 }, signal());
  const list = JSON.parse(result.content);
  expect(list.total).toBe(63);
  expect(list.tools.map((tool: { toolId: string }) => tool.toolId)).toEqual([
    'wire_5',
    'wire_6',
    'wire_7',
    'wire_8',
    'wire_9',
  ]);
  expect(list.nextOffset).toBe(10);
  expect(list.tools.every((tool: { description: string }) => tool.description.length <= 160)).toBe(
    true,
  );
  expect(result.content).not.toContain('schema_only_');
  expect(execute).not.toHaveBeenCalled();
});

it('searches summaries, then returns the full contract for only the selected tool', async () => {
  const { discovery, tools, execute } = setup();
  const list = JSON.parse(
    (await discovery.execute('ListIntegrationTools', { query: 'issue 42.' }, signal())).content,
  );
  expect(list.tools).toHaveLength(1);
  const keywordList = JSON.parse(
    (await discovery.execute('ListIntegrationTools', { query: 'operation_42 Search' }, signal()))
      .content,
  );
  expect(keywordList.tools.map((tool: { toolId: string }) => tool.toolId)).toEqual(['wire_42']);
  const described = JSON.parse(
    (await discovery.execute('DescribeIntegrationTool', { toolId: list.tools[0].toolId }, signal()))
      .content,
  );
  expect(described.name).toBe('mcp__jira__operation_42');
  expect(described.inputSchema).toEqual(tools[42].input_schema);
  expect(described.description).toContain('detail '.repeat(100).trim());
  expect(JSON.stringify(described)).not.toContain('schema_only_41');
  expect(execute).not.toHaveBeenCalled();
  expect(
    await discovery.execute(
      'InvokeIntegrationTool',
      {
        toolId: described.toolId,
        catalogRevision: described.catalogRevision,
        arguments: { schema_only_42: 'requested' },
      },
      signal(),
    ),
  ).toEqual({ content: 'approved peer result', isError: false });
  expect(execute).toHaveBeenCalledWith(
    'wire_42',
    { schema_only_42: 'requested' },
    expect.any(AbortSignal),
  );
});

it('rejects unknown, malformed, or stale invocation requests before the executor', async () => {
  const { discovery, execute } = setup();
  for (const input of [
    { toolId: 'wire_0', catalogRevision: 'old', arguments: {} },
    { toolId: 'wire_missing', catalogRevision: 'old', arguments: {} },
    { toolId: 'wire_0', arguments: {} },
    { toolId: 'wire_0', catalogRevision: 'old', arguments: [] },
    { toolId: 'wire_0', catalogRevision: 'old', arguments: {}, unexpected: true },
  ]) {
    expect((await discovery.execute('InvokeIntegrationTool', input, signal())).isError).toBe(true);
  }
  expect((await discovery.execute('ListIntegrationTools', { limit: 1000 }, signal())).isError).toBe(
    true,
  );
  expect(execute).not.toHaveBeenCalled();
});

it('pins the admitted catalog and changes the provider surface fingerprint when a contract changes', async () => {
  const { discovery, tools } = setup();
  const before = JSON.stringify(discovery.definitions);
  tools[0].input_schema.properties.schema_only_0.description = 'changed after admission';
  expect(
    (await discovery.execute('DescribeIntegrationTool', { toolId: 'wire_0' }, signal())).content,
  ).not.toContain('changed after admission');
  expect(JSON.stringify(discovery.definitions)).toBe(before);
  const replacement = createIntegrationToolDiscovery({
    tools,
    displayName: (id) => `mcp__jira__operation_${id.slice(5)}`,
    assertCurrent: () => {},
    execute: vi.fn(),
  });
  expect(JSON.stringify(replacement.definitions)).not.toBe(before);
});

it('checks cancellation and current ownership for metadata and after asynchronous invocation', async () => {
  let current = true;
  const execute = vi.fn(async () => {
    current = false;
    return { content: 'stale private data', isError: false };
  });
  const discovery = createIntegrationToolDiscovery({
    tools: fixtures(1),
    displayName: (id) => id,
    assertCurrent: () => {
      if (!current) throw Error('revoked');
    },
    execute,
  });
  const detail = JSON.parse(
    (await discovery.execute('DescribeIntegrationTool', { toolId: 'wire_0' }, signal())).content,
  );
  const aborted = new AbortController();
  aborted.abort();
  await expect(discovery.execute('ListIntegrationTools', {}, aborted.signal)).rejects.toThrow();
  await expect(
    discovery.execute(
      'InvokeIntegrationTool',
      { toolId: 'wire_0', catalogRevision: detail.catalogRevision, arguments: {} },
      signal(),
    ),
  ).rejects.toThrow('revoked');
  await expect(
    discovery.execute('DescribeIntegrationTool', { toolId: 'wire_0' }, signal()),
  ).rejects.toThrow('revoked');
});

it('exposes no discovery bridge for an empty selected catalog and pages large contracts without losing bytes', async () => {
  const empty = createIntegrationToolDiscovery({
    tools: [],
    displayName: (id) => id,
    assertCurrent: () => {},
    execute: vi.fn(),
  });
  expect(empty.definitions).toEqual([]);
  expect(empty.instructions).toBe('');
  const tools = fixtures(1);
  tools[0].input_schema.properties.schema_only_0.description = '🦉"\\\n漢'.repeat(20000);
  const large = createIntegrationToolDiscovery({
    tools,
    displayName: (id) => id,
    assertCurrent: () => {},
    execute: vi.fn(),
  });
  let offset: number | null = 0;
  let contract = '';
  while (offset !== null) {
    const result = await large.execute(
      'DescribeIntegrationTool',
      { toolId: 'wire_0', offset },
      signal(),
    );
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content)).toBeLessThan(48 * 1024);
    const page = JSON.parse(result.content);
    contract += page.contractFragment;
    offset = page.nextOffset;
  }
  expect(JSON.parse(contract).inputSchema).toEqual(tools[0].input_schema);
});

it('keeps invalid, stale and unselected invocation activity in its bridge envelope', async () => {
  const { discovery } = setup();
  const detail = JSON.parse(
    (await discovery.execute('DescribeIntegrationTool', { toolId: 'wire_42' }, signal())).content,
  );
  const valid = {
    toolId: detail.toolId,
    catalogRevision: detail.catalogRevision,
    arguments: { issue: 'J-42' },
  };
  expect(discovery.displayCall('InvokeIntegrationTool', valid)).toEqual({
    name: 'mcp__jira__operation_42',
    input: valid.arguments,
  });
  for (const input of [
    { toolId: 'wire_42' },
    { ...valid, catalogRevision: 'stale' },
    { ...valid, toolId: 'unselected' },
  ]) {
    expect(discovery.displayCall('InvokeIntegrationTool', input)).toEqual({
      name: 'InvokeIntegrationTool',
      input,
    });
  }
  expect(discovery.displayCall('ListIntegrationTools', {})).toEqual({
    name: 'ListIntegrationTools',
    input: {},
  });
});

const commonConnectionNames = [
  'ListConnections',
  'RequestConnectionAccess',
  'GetConnectionGuide',
  'ConnectionRequest',
];
const directDiscovery = (directTools = credentialConnectionToolDefinitions) =>
  createIntegrationToolDiscovery({
    tools: [],
    directOnly: true,
    directTools,
    displayName: (name) => name,
    assertCurrent: () => {},
    execute: vi.fn(),
  });

it('exposes exact small common connection contracts without a describe round trip', async () => {
  const discovery = directDiscovery();
  for (const name of commonConnectionNames) {
    const original = credentialConnectionToolDefinitions.find((tool) => tool.name === name)!;
    const definition = discovery.directDefinitions.find((tool) => tool.name === name)!;
    expect(definition).toEqual(original);
    expect(Buffer.byteLength(JSON.stringify(definition))).toBeLessThanOrEqual(4096);
    expect(definition.description).not.toContain('Call DescribeIntegrationTool');
    const detail = JSON.parse(
      (await discovery.execute('DescribeIntegrationTool', { toolId: name }, signal())).content,
    );
    expect(detail).toMatchObject({
      name,
      invocation: 'direct',
      inputSchema: original.input_schema,
    });
    expect(discovery.displayCall(name, {})).toEqual({ name, input: {} });
  }
  expect(discovery.instructions).toContain('Call tools with full argument schemas directly');
  expect(discovery.instructions).toContain('only for abbreviated contracts');
  expect(
    discovery.definitions.find((tool) => tool.name === 'DescribeIntegrationTool')?.description,
  ).toContain('Tools already exposing full schemas can be called directly');
  expect(discovery.definitions.map((tool) => tool.name)).toEqual([
    'ListIntegrationTools',
    'DescribeIntegrationTool',
  ]);
  expect((await discovery.execute('InvokeIntegrationTool', {}, signal())).isError).toBe(true);
});

it('defers uncommon tools and oversized common contracts while retaining exact details', async () => {
  const oversized = {
    name: 'ConnectionRequest',
    description: 'Large future contract.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '🦉'.repeat(1500) } },
    },
  };
  const uncommon = { ...oversized, name: 'UncommonHostTool', input_schema: { type: 'object' } };
  const discovery = directDiscovery([oversized, uncommon]);
  for (const original of [oversized, uncommon]) {
    const definition = discovery.directDefinitions.find((tool) => tool.name === original.name)!;
    expect(definition.input_schema).toEqual({ type: 'object', additionalProperties: true });
    expect(definition.description).toContain('Call DescribeIntegrationTool');
    expect(
      JSON.parse(
        (await discovery.execute('DescribeIntegrationTool', { toolId: original.name }, signal()))
          .content,
      ).inputSchema,
    ).toEqual(original.input_schema);
  }
});

it('preserves selected identities and pins common contracts and their full catalog fingerprint', async () => {
  const selected = credentialConnectionToolDefinitions
    .filter((tool) => tool.name === 'ListConnections')
    .map((tool) => structuredClone(tool));
  const discovery = directDiscovery(selected);
  const before = JSON.stringify(discovery.definitions);
  const fullDefinition = structuredClone(discovery.directDefinitions[0]);
  selected[0].description += ' New access guidance.';
  selected[0].input_schema = { type: 'object', properties: { changed: { type: 'string' } } };
  expect(discovery.directDefinitions).toEqual([fullDefinition]);
  expect(JSON.stringify(discovery.definitions)).toBe(before);
  expect(JSON.stringify(directDiscovery(selected).definitions)).not.toBe(before);
  expect(discovery.directDefinitions.map((tool) => tool.name)).toEqual(['ListConnections']);
  Object.assign(discovery.directDefinitions[0].input_schema, { type: 'array' });
  expect(
    JSON.parse(
      (await discovery.execute('DescribeIntegrationTool', { toolId: 'ListConnections' }, signal()))
        .content,
    ).inputSchema,
  ).toEqual(fullDefinition.input_schema);
  expect(JSON.stringify(discovery.definitions)).toBe(before);
  expect(
    (await discovery.execute('DescribeIntegrationTool', { toolId: 'ConnectionRequest' }, signal()))
      .isError,
  ).toBe(true);
  expect(directDiscovery([]).directDefinitions).toEqual([]);
});
