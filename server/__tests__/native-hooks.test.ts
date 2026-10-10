import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeHooks, NativeHooks } from '../native-hooks.js';
import * as commands from '../protected-sdk-command.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());
function setup(hooks: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-hooks-'));
  roots.push(root);
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks }));
  return new NativeHooks(root, 'app', { PATH: '/usr/bin:/bin' });
}
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
