import { callbackOutcome, retainCallbackOutcome } from '../turn-callbacks.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeHooks, NativeHooks } from '../native-hooks.js';
import * as commands from '../protected-sdk-command.js';
import { sdkProjectCommandFixture } from './fixtures/sdk-project-command.js';
const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(commands, 'createWorkspaceRuntimeCommandRunner').mockReturnValue(
    sdkProjectCommandFixture,
  );
});
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());
function setup(hooks: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks }));
  return new NativeHooks(root, 'app', { PATH: '/usr/bin:/bin' });
}
it('settles returned read failures by default and keeps the next tool available', async () => {
  const hooks = setup({});
  const signal = new AbortController().signal;
  const failed = await hooks.executeTool('ReadKnowledge', {}, signal, async () => ({
    content: 'Document revision unavailable',
    isError: true,
  }));
  expect(callbackOutcome(failed)).toBe('settled');
  expect(failed.content).toBe('Document revision unavailable');
  expect(
    await hooks.executeTool('ReadKnowledge', {}, signal, async () => ({
      content: 'Another document',
      isError: false,
    })),
  ).toMatchObject({ isError: false });
});

it.each(['settled', 'unknown'] as const)(
  'reports a %s thrown tool failure without losing the original receipt',
  async (outcome) => {
    const hooks = setup({});
    const result = await hooks.executeTool(
      'AnyTool',
      {},
      new AbortController().signal,
      async () => {
        throw retainCallbackOutcome(
          Object.assign(Error('sensitive upstream payload'), { code: 'ENOMEM' }),
          outcome,
        );
      },
    );
    expect(result.isError).toBe(true);
    expect(callbackOutcome(result)).toBe(outcome);
    expect(result.content).not.toContain('sensitive upstream payload');
    expect(JSON.parse(result.content)).toMatchObject({
      diagnostic: { reason: 'memory_exhausted' },
    });
  },
);
it('preserves an original settled refusal when cancellation arrives before any post-tool hook', async () => {
  const hooks = setup({ PostToolUse: [{ hooks: [{ type: 'command', command: 'exit 1' }] }] });
  const run = vi.spyOn(hooks, 'run');
  const abort = new AbortController();
  const refusal = retainCallbackOutcome(
    { content: 'Tool execution cancelled before execution', isError: true },
    'settled',
  );
  const result = await hooks.executeTool('GitHubRead', {}, abort.signal, async () => {
    abort.abort(new Error('Original turn completed'));
    return refusal;
  });
  expect(result).toEqual(refusal);
  expect(callbackOutcome(result)).toBe('settled');
  expect(run.mock.calls.map(([event]) => event)).toEqual(['PreToolUse']);
});

it.each(['unqualified failure', 'explicit uncertainty', 'unqualified success'])(
  'retains %s after cancellation without inventing settlement',
  async (kind) => {
    const hooks = setup({});
    const abort = new AbortController();
    const result = await hooks.executeTool('Read', {}, abort.signal, async () => {
      abort.abort();
      const raw = { content: 'late result', isError: kind !== 'unqualified success' };
      return kind === 'explicit uncertainty' ? retainCallbackOutcome(raw, 'unknown') : raw;
    });
    expect(result.isError).toBe(true);
    expect(callbackOutcome(result)).toBe('unknown');
  },
);

it('preserves rich results and sends only text to project hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-rich-'));
  roots.push(root);
  const hooks = new NativeHooks(root, 'app', {}, false);
  const run = vi.spyOn(hooks, 'run').mockImplementation(async (event) => ({
    context: event === 'PostToolUse' ? 'feedback' : '',
    forcePrompt: false,
  }));
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const rich = {
    content: 'screen',
    isError: false,
    contentItems: [
      { type: 'inputText' as const, text: 'screen' },
      { type: 'inputImage' as const, imageUrl: `data:image/png;base64,${data}` },
    ],
  };
  const result = await hooks.executeTool(
    'Screenshot',
    {},
    new AbortController().signal,
    async () => rich,
  );
  expect(result).toMatchObject({
    contentItems: [
      { type: 'inputText', text: 'screen\n\nProject hook feedback:\nfeedback' },
      rich.contentItems[1],
    ],
  });
  expect(run).toHaveBeenLastCalledWith(
    'PostToolUse',
    { tool_name: 'Screenshot', tool_input: {}, tool_response: 'screen' },
    expect.any(AbortSignal),
  );
  const refusal = retainCallbackOutcome(
    { content: 'validation rejected', isError: true },
    'settled',
  );
  expect(
    callbackOutcome(
      await hooks.executeTool('Write', {}, new AbortController().signal, async () => refusal),
    ),
  ).toBe('settled');
  run.mockRejectedValueOnce(Error('read hook partially ran'));
  expect(
    callbackOutcome(
      await hooks.executeTool('Read', {}, new AbortController().signal, async () => ({
        content: 'unused',
        isError: false,
      })),
    ),
  ).toBe('unknown');
});

it('diagnoses oversized post-hook rich output without repeating the effect or exposing image bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-bound-'));
  roots.push(root);
  const hooks = new NativeHooks(root, 'app', {}, false);
  vi.spyOn(hooks, 'run').mockImplementation(async (event) => ({
    context: event === 'PostToolUse' ? 'x'.repeat(65_536) : '',
    forcePrompt: false,
  }));
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const execute = vi.fn(async () => ({
    content: '',
    isError: false,
    contentItems: [{ type: 'inputImage' as const, imageUrl: `data:image/png;base64,${data}` }],
  }));
  const result = await hooks.executeTool('Screenshot', {}, new AbortController().signal, execute);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/Tool ran.*bound/);
  expect(JSON.stringify(result)).not.toContain(data);
  expect(execute).toHaveBeenCalledOnce();
  expect(callbackOutcome(result)).toBe('unknown');
});
it.each([true, false])(
  'preserves ordinary custom data in hooks and execution (enabled=%s)',
  async (enabled) => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-data-'));
    roots.push(root);
    const hooks = new NativeHooks(root, 'app', {}, enabled);
    const run = vi.spyOn(hooks, 'run');
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      content: JSON.stringify(input),
      isError: false,
    }));
    const signal = new AbortController().signal;
    expect(
      await hooks.executeTool('CustomData', { file_path: 'a.txt' }, signal, execute, {
        normalizeFilePath: false,
      }),
    ).toEqual({ content: '{"file_path":"a.txt"}', isError: false });
    expect(execute).toHaveBeenCalledWith({ file_path: 'a.txt' }, false);
    expect(run).toHaveBeenNthCalledWith(
      1,
      'PreToolUse',
      {
        tool_name: 'CustomData',
        tool_input: { file_path: 'a.txt' },
      },
      signal,
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'PostToolUse',
      {
        tool_name: 'CustomData',
        tool_input: { file_path: 'a.txt' },
        tool_response: '{"file_path":"a.txt"}',
      },
      signal,
    );
  },
);
it('retains filesystem path normalization by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-path-'));
  roots.push(root);
  const hooks = new NativeHooks(root, 'app', {}, false);
  const execute = vi.fn(async () => ({ content: 'read', isError: false }));
  await hooks.executeTool('Read', { file_path: 'a.txt' }, new AbortController().signal, execute);
  expect(execute).toHaveBeenCalledWith({ file_path: join(root, 'a.txt') }, false);
});
it('enforces tool-hook denial and matcher boundaries', async () => {
  const hooks = setup({
    PreToolUse: [
      {
        matcher: 'Write|Edit',
        hooks: [
          {
            type: 'command',
            command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Protected file"}}'`,
          },
        ],
      },
    ],
  });
  await expect(
    hooks.run('PreToolUse', { tool_name: 'Write', tool_input: {} }, new AbortController().signal),
  ).rejects.toThrow('Protected file');
  expect(
    await hooks.run(
      'PreToolUse',
      { tool_name: 'Read', tool_input: {} },
      new AbortController().signal,
    ),
  ).toEqual({ context: '', forcePrompt: false });
});
it('preserves approval requests, rewritten input and context', async () => {
  const hooks = setup({
    PreToolUse: [
      {
        hooks: [
          {
            type: 'command',
            command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{"file_path":"checked"},"additionalContext":"Review this"}}'`,
          },
        ],
      },
    ],
  });
  expect(
    await hooks.run('PreToolUse', { tool_name: 'Write' }, new AbortController().signal),
  ).toEqual({ context: 'Review this', forcePrompt: true, input: { file_path: 'checked' } });
});
it('fails closed on hook failure without disclosing command output', async () => {
  const hooks = setup({
    PreToolUse: [{ hooks: [{ type: 'command', command: 'echo private-value >&2; exit 2' }] }],
  });
  await expect(
    hooks.run('PreToolUse', { tool_name: 'Write' }, new AbortController().signal),
  ).rejects.toThrow(/^Project PreToolUse hook failed\.$/);
});

it('holds execution at the hook boundary and forwards approval without broadening policy', async () => {
  const hooks = setup({
    PreToolUse: [
      {
        hooks: [
          {
            type: 'command',
            command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{"file_path":"checked"}}}'`,
          },
        ],
      },
    ],
  });
  let calls = 0;
  const result = await hooks.executeTool(
    'Write',
    { file_path: 'original' },
    new AbortController().signal,
    async (input, forcePrompt) => {
      calls++;
      expect(input.file_path).toBe('checked');
      expect(forcePrompt).toBe(true);
      return { content: 'written', isError: false };
    },
  );
  expect(calls).toBe(1);
  expect(result).toEqual({ content: 'written', isError: false });
});

it('disables repository-controlled hooks by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-default-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'));
  const marker = join(root, 'executed');
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] },
    }),
  );
  const created = createNativeHooks(root, 'app', {
    PATH: '/usr/bin:/bin',
    CODEX_HOME: '/private/credentials',
  });
  try {
    await created.hooks.run('SessionStart', { source: 'startup' }, new AbortController().signal);
    expect(existsSync(marker)).toBe(false);
  } finally {
    created.dispose();
  }
});

it('uses the runtime fence for native project hooks while preserving input, environment and context', async () => {
  const command = 'touch "$CLAUDE_PROJECT_DIR/authority-tampered"';
  const hooks = setup({ SessionStart: [{ hooks: [{ type: 'command', command }] }] });
  const root = roots.at(-1)!;
  const runner = vi.fn<commands.ProtectedSdkCommandRunner>().mockResolvedValue({
    stdout: JSON.stringify({ additionalContext: 'Protected fixture context' }),
    stderr: '',
  });
  vi.spyOn(commands, 'createWorkspaceRuntimeCommandRunner').mockReturnValue(runner);
  const signal = new AbortController().signal;
  const result = await hooks.run('SessionStart', { source: 'startup' }, signal);
  expect(runner).toHaveBeenCalledWith(
    '/bin/sh',
    ['-c', command],
    expect.objectContaining({
      cwd: root,
      env: { PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: root },
      signal,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
    }),
  );
  expect(JSON.parse(runner.mock.calls[0][2].input!)).toEqual({
    source: 'startup',
    hook_event_name: 'SessionStart',
    session_id: 'app',
    cwd: root,
    transcript_path: '',
  });
  expect(result).toEqual({ context: 'Protected fixture context', forcePrompt: false });
  expect(existsSync(join(root, 'authority-tampered'))).toBe(false);
});

it('never falls back to host execution when runtime hook protection is unavailable', async () => {
  const hooks = setup({
    SessionStart: [
      { hooks: [{ type: 'command', command: 'touch "$CLAUDE_PROJECT_DIR/authority-tampered"' }] },
    ],
  });
  const root = roots.at(-1)!;
  vi.spyOn(commands, 'createWorkspaceRuntimeCommandRunner').mockImplementation(() => {
    throw new Error('Fixture protection unavailable');
  });
  await expect(
    hooks.run('SessionStart', { source: 'startup' }, new AbortController().signal),
  ).rejects.toThrow(/^Project SessionStart hook failed\.$/);
  expect(existsSync(join(root, 'authority-tampered'))).toBe(false);
});

it('reports only matching enabled Stop hooks without executing them', () => {
  const hooks = setup({
    Stop: [
      { matcher: '^other$', hooks: [{ type: 'command', command: 'exit 9' }] },
      { matcher: '^$', hooks: [] },
    ],
  });
  expect(hooks.hasMatching('Stop', { stop_hook_active: false })).toBe(false);
  expect(hooks.hasMatching('Stop', { reason: 'other' })).toBe(true);
  expect(new NativeHooks('/no-project', 'offline', {}, false).hasMatching('Stop', {})).toBe(false);
});
