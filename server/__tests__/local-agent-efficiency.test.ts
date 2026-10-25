import { codexThreadOptions } from '../codex-ordinary-packet.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { normalizeMcpToolResult } from '../codex-tool-result.js';
import {
  projectToolOutput,
  readToolOutputPage,
  TOOL_OUTPUT_PREVIEW_BYTES,
} from '../tool-output-projection.js';
import {
  assembleInstructionSections,
  SearchSkillsInput,
  searchNativeSkills,
} from '../local-agent-efficiency.js';
import { CodexToolFailure, codexToolFailureResult } from '../codex-tool-failure.js';
import { createIntegrationToolDiscovery } from '../integration-tool-discovery.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
const account = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-fixture',
  profileRevision: 'fixture',
};

it('retains complete pre-truncation MCP text across restart, isolates accounts/conversations, and serves bounded searchable pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-output-proof-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'native.db');
  let store = new CodexConversationStore(path);
  cleanup.push(() => store.close());
  store.create('first', account, root);
  store.create('second', account, root);
  const full = JSON.stringify({
    rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, value: `漢🦉 record ${i}` })),
    last: 'needle-at-tail',
  });
  const result = normalizeMcpToolResult([{ type: 'text', text: full }], false, (text) =>
    projectToolOutput(text, (raw) =>
      store.retainToolOutput('first', account, 'wire', raw, 'a'.repeat(64)),
    ),
  );
  expect(result.isError).toBe(false);
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_BYTES);
  const preview = JSON.parse(result.content);
  expect(preview).toMatchObject({
    format: 'tool-output-preview',
    complete: false,
    totalBytes: Buffer.byteLength(full),
  });
  store.close();
  store = new CodexConversationStore(path);
  expect(store.readToolOutput('second', account, preview.outputId)).toBeUndefined();
  expect(() =>
    store.readToolOutput('first', { ...account, accountId: 'other' }, preview.outputId),
  ).toThrow();
  const output = store.readToolOutput('first', account, preview.outputId)!;
  expect(output).toEqual({ toolName: 'wire', sourceScope: 'a'.repeat(64), content: full });
  const page = readToolOutputPage(output.content, {
    offset: 0,
    limit: 256,
    query: 'needle-at-tail',
  });
  if (!('content' in page)) throw Error('Expected a matching output page');
  expect(page.content).toContain('needle-at-tail');
  let offset: number | null = 0,
    restored = '';
  while (offset !== null) {
    const part = readToolOutputPage(output.content, { offset, limit: 4096 });
    if (!('content' in part)) throw Error('Expected an output page');
    expect(Buffer.byteLength(part.content)).toBeLessThanOrEqual(4096);
    restored += part.content;
    offset = part.nextOffset;
  }
  expect(restored).toBe(full);
  for (let i = 0; i < 8; i++)
    store.retainToolOutput('first', account, 'wire', `later ${i}`, 'a'.repeat(64));
  expect(store.readToolOutput('first', account, preview.outputId)).toBeUndefined();
  const current = store.retainToolOutput('first', account, 'wire', 'expires', 'a'.repeat(64));
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 86400001);
  expect(store.readToolOutput('first', account, current)).toBeUndefined();
});

it.each(['漢🦉'.repeat(10000), '\u0000"\\\n'.repeat(20000)])(
  'keeps escaped and non-ASCII previews within budget',
  (text) => {
    const preview = projectToolOutput(text, () => 'retained');
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(preview).outputId).toBe('retained');
    expect(preview).not.toContain('\ufffd');
  },
);

it('preserves successful effects when retention fails and does not pretend oversized output is retained', () => {
  const full = 'x'.repeat(10000);
  expect(
    JSON.parse(
      projectToolOutput(full, () => {
        throw Error('private credentials');
      }),
    ),
  ).toMatchObject({ complete: false, retention: 'unavailable' });
  const retain = vi.fn();
  expect(JSON.parse(projectToolOutput('x'.repeat(4 * 1024 * 1024 + 1), retain))).toMatchObject({
    retention: 'too_large',
  });
  expect(retain).not.toHaveBeenCalled();
  expect(projectToolOutput('small', retain)).toBe('small');
});

it('abbreviates large platform schemas while keeping original invocation identity and exact discoverable contracts', async () => {
  const direct = {
    name: 'SymposiumProposeProfile',
    description: 'Propose a draft; requires approval.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'details '.repeat(1000) } },
    },
  };
  const execute = vi.fn();
  const discovery = createIntegrationToolDiscovery({
    tools: [],
    directTools: [direct],
    displayName: () => {
      throw Error('Not an MCP identity');
    },
    assertCurrent: () => {},
    execute,
  });
  expect(JSON.stringify(discovery.directDefinitions).length).toBeLessThan(
    JSON.stringify(direct).length / 4,
  );
  const detail = JSON.parse(
    (
      await discovery.execute(
        'DescribeIntegrationTool',
        { toolId: direct.name },
        new AbortController().signal,
      )
    ).content,
  );
  expect(detail).toMatchObject({
    name: direct.name,
    invocation: 'direct',
    inputSchema: direct.input_schema,
  });
  expect(
    (
      await discovery.execute(
        'InvokeIntegrationTool',
        { toolId: direct.name, catalogRevision: detail.catalogRevision, arguments: {} },
        new AbortController().signal,
      )
    ).isError,
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  expect(
    discovery.displayCall('InvokeIntegrationTool', {
      toolId: direct.name,
      catalogRevision: detail.catalogRevision,
      arguments: {},
    }).name,
  ).toBe('InvokeIntegrationTool');
});

it('searches only the current enabled native skill catalogue and preserves exact selected paths', () => {
  const skill = {
    name: 'jira',
    description: 'Search Jira issues and update tickets',
    path: '/skills/jira/SKILL.md',
    enabled: true,
  };
  const response = {
    data: [
      {
        cwd: '/workspace',
        skills: [skill, { ...skill, name: 'disabled', enabled: false }],
        errors: [],
      },
      { cwd: '/other', skills: [{ ...skill, name: 'other' }], errors: [] },
    ],
  };
  expect(
    searchNativeSkills(response, SearchSkillsInput.parse({ query: 'jira update' }), '/workspace'),
  ).toMatchObject({ total: 1, skills: [{ name: 'jira', path: skill.path }], nextOffset: null });
  expect(() => searchNativeSkills(response, SearchSkillsInput.parse({}), '/missing')).toThrow();
});

it('deduplicates exact instruction sections with provenance and preserves different mandatory text', () => {
  const result = assembleInstructionSections([
    { source: 'profile', text: 'Mandatory A' },
    { source: 'recipe', text: 'Mandatory A' },
    { source: 'policy', text: 'Mandatory B' },
  ]);
  expect(result.text).toBe('Mandatory A\nMandatory B');
  expect(result.manifest).toHaveLength(2);
  expect(result.manifest[0].sources).toEqual(['profile', 'recipe']);
  expect(JSON.stringify(result.manifest)).not.toContain('Mandatory');
});

it('classifies typed failures and cancellation without echoing unknown exception details', () => {
  expect(
    JSON.parse(codexToolFailureResult(new CodexToolFailure('stale_owner'), false).content).error,
  ).toBe('stale_owner');
  expect(
    JSON.parse(codexToolFailureResult(Error('private credential value'), true).content).error,
  ).toBe('cancelled');
  const unknown = codexToolFailureResult(Error('private credential value'), false);
  expect(JSON.parse(unknown.content)).toMatchObject({
    error: 'internal_failure',
    retry: 'after_reconciliation',
  });
  expect(unknown.content).not.toContain('private credential');
});

it('uses native skill budgeting without replacing runtime or permission configuration', () => {
  const packet = codexThreadOptions({
    model: 'offline',
    modelProvider: 'openai',
    cwd: '/workspace',
    runtimeConfig: { permissions: { selected: 'retained' }, web_search: 'disabled' },
    webSearch: 'disabled',
    systemPrompt: 'Mandatory guidance',
    skillContextTokens: 1500,
  });
  expect(packet.config).toMatchObject({
    permissions: { selected: 'retained' },
    'skills.max_context_tokens': 1500,
  });
  expect(packet.developerInstructions).toContain('Mandatory guidance');
});

it('keeps escaped output pages parseable within the delivery budget without losing content', () => {
  const text = '\u0000"\\\n'.repeat(5000);
  let offset: number | null = 0;
  let restored = '';
  while (offset !== null) {
    const page = readToolOutputPage(text, { offset, limit: 4096 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
    if (!('content' in page)) throw Error('Expected an output page');
    expect(page.content.length).toBeGreaterThan(0);
    restored += page.content;
    offset = page.nextOffset;
  }
  expect(restored).toBe(text);
});

it('allows pagination beyond the original MCP-only catalogue bound', async () => {
  const discovery = createIntegrationToolDiscovery({
    tools: Array.from({ length: 1000 }, (_, i) => ({
      name: `mcp_${i}`,
      description: '',
      input_schema: {},
    })),
    directTools: Array.from({ length: 8 }, (_, i) => ({
      name: `direct_${i}`,
      description: '',
      input_schema: {},
    })),
    displayName: (name) => name,
    assertCurrent: () => {},
    execute: vi.fn(),
  });
  const result = await discovery.execute(
    'ListIntegrationTools',
    { offset: 1001, limit: 1 },
    new AbortController().signal,
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content).tools).toHaveLength(1);
});
