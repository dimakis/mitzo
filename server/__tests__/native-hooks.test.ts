import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeHooks } from '../native-hooks.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
