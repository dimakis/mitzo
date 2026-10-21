import { describe, expect, it } from 'vitest';
import {
  codexApplicationContextFragments,
  codexDynamicToolsOption,
  codexThreadOptions,
  codexTurnStartParams,
} from '../codex-ordinary-packet.js';

describe('ordinary Codex host packet serialization', () => {
  it('preserves persistent guidance, native document isolation and effective runtime policy', () => {
    expect(
      codexThreadOptions({
        model: 'offline',
        modelProvider: 'openai',
        cwd: '/workspace',
        runtimeConfig: { model_reasoning_summary: 'concise', web_search: 'live' },
        webSearch: 'disabled',
        disableProjectDocuments: true,
        systemPrompt: 'Frozen profile and actual ordinary guidance',
      }),
    ).toEqual({
      model: 'offline',
      modelProvider: 'openai',
      cwd: '/workspace',
      config: {
        model_reasoning_summary: 'concise',
        web_search: 'disabled',
        project_doc_max_bytes: 0,
      },
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: expect.stringContaining('Frozen profile and actual ordinary guidance'),
    });
    expect(
      codexThreadOptions({
        model: 'offline',
        modelProvider: 'openai',
        cwd: '/workspace',
        runtimeConfig: {},
        webSearch: 'disabled',
        systemPrompt: '',
      }).config,
    ).toEqual({ model_reasoning_summary: 'auto', web_search: 'disabled' });
  });

  it('uses the real dynamic tool mapping and omits the option for an empty tool surface', () => {
    expect(codexDynamicToolsOption([])).toEqual({});
    expect(
      codexDynamicToolsOption([
        {
          name: 'Read',
          description: 'Read selected files',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ]),
    ).toEqual({
      dynamicTools: [
        {
          type: 'function',
          name: 'Read',
          description: 'Read selected files',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
  });

  it('preserves exact input order, command identity, images, effort, policy and application framing', () => {
    const additionalContext = codexApplicationContextFragments('Accepted repository context');
    expect(
      codexTurnStartParams({
        threadId: 'thread',
        commandId: 'command',
        model: 'offline',
        prompt: 'Prepared user command',
        attemptContext: 'Prior attempt',
        savedSourceContext: 'Saved source',
        images: [{ mediaType: 'image/png', data: 'AQ==' }],
        reasoningEffort: 'low',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'] },
        additionalContext,
      }),
    ).toEqual({
      threadId: 'thread',
      clientUserMessageId: 'command',
      model: 'offline',
      input: [
        { type: 'text', text: 'Prior attempt' },
        { type: 'text', text: 'Saved source' },
        { type: 'text', text: 'Prepared user command' },
        { type: 'image', url: 'data:image/png;base64,AQ==' },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'] },
      effort: 'low',
      additionalContext,
    });
  });

  it('accepts the ordinary command nullable effort and omits it from the native request', () => {
    const input = {
      threadId: 'thread',
      commandId: 'command',
      model: 'offline',
      prompt: 'Original request',
      additionalContext: {},
      reasoningEffort: null,
    } satisfies Parameters<typeof codexTurnStartParams>[0];
    expect(codexTurnStartParams(input)).not.toHaveProperty('effort');
  });

  it('keeps native continuation input empty and omits absent optional parameters', () => {
    const base = {
      threadId: 'thread',
      commandId: 'command',
      model: 'offline',
      prompt: 'Original request',
      additionalContext: {},
    };
    expect(codexTurnStartParams(base)).toEqual({
      threadId: 'thread',
      clientUserMessageId: 'command',
      model: 'offline',
      input: [{ type: 'text', text: 'Original request' }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' },
    });
    expect(
      codexTurnStartParams({
        ...base,
        continuation: true,
        attemptContext: 'Do not replay',
        savedSourceContext: 'Do not replay',
        images: [{ mediaType: 'image/png', data: 'AQ==' }],
      }).input,
    ).toEqual([]);
  });

  it('preserves every Unicode byte in generation-bound ordered application fragments', () => {
    const value = 'Complete repository guidance 🦉 完整上下文\n'.repeat(100);
    const fragments = codexApplicationContextFragments(value);
    const keys = Object.keys(fragments).sort();
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.map((key) => fragments[key].value).join('')).toBe(value);
    expect(
      Object.values(fragments).every(
        (fragment) => fragment.kind === 'application' && Buffer.byteLength(fragment.value) <= 800,
      ),
    ).toBe(true);
    const changed = codexApplicationContextFragments(value + 'changed');
    expect(Object.keys(changed).some((key) => key in fragments)).toBe(false);
    expect(() => codexApplicationContextFragments('\ud800')).toThrow('invalid Unicode');
    expect(() => codexApplicationContextFragments('x'.repeat(1048577))).toThrow('delivery bound');
  });
});

it.each(['live', 'disabled'] as const)(
  'gives the main Codex thread research guidance matching %s access',
  (webSearch) => {
    const options = codexThreadOptions({
      model: 'offline',
      modelProvider: 'openai',
      cwd: '/workspace',
      runtimeConfig: { web_search: 'live' },
      webSearch,
      systemPrompt: 'Original guidance',
    });
    expect(options.developerInstructions).toContain('Original guidance');
    expect(options.developerInstructions).toContain('Reuse sources already read');
    expect(options.developerInstructions).toContain('filter fields and paginate');
    expect(options.developerInstructions).toContain('concrete evidence gap');
    if (webSearch === 'live') {
      expect(options.developerInstructions).toContain('Native web search is enabled');
      expect(options.developerInstructions).toContain('Prefer native search, open and find');
      expect(options.developerInstructions).not.toContain('Native web search is disabled');
    } else {
      expect(options.developerInstructions).toContain('Native web search is disabled');
      expect(options.developerInstructions).toContain('between turns');
      expect(options.developerInstructions).not.toContain('Native web search is enabled');
    }
    expect(options.config.web_search).toBe(webSearch);
  },
);

it.each(['live', 'disabled'] as const)(
  'declares standalone OpenShell search capability only under %s effective consent',
  (webSearch) => {
    const options = codexThreadOptions({
      model: 'gpt-6-luna',
      modelProvider: 'openshell',
      cwd: '/workspace',
      runtimeConfig: { web_search: 'live' },
      webSearch,
      systemPrompt: '',
    });
    expect(options.config.web_search).toBe(webSearch);
    if (webSearch === 'live') {
      expect(options.config).toMatchObject({
        'features.code_mode_host': true,
        'model_providers.openshell.supports_standalone_web_search': true,
      });
    } else {
      expect(options.config).not.toHaveProperty(
        'model_providers.openshell.supports_standalone_web_search',
      );
    }
  },
);
