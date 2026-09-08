import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionPermissionHooks,
  SESSION_PERMISSION_INSTRUCTIONS,
  HOST_TOOL_INSTRUCTIONS,
} from '../session-permission-policy.js';

describe('provider-independent permission authority', () => {
  const input = {
    hook_event_name: 'PreToolUse' as const,
    session_id: 's',
    transcript_path: '',
    cwd: '/repo',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/a', content: 'a' },
  };
  it('gates even SDK auto-approved tools before execution', async () => {
    const decide = vi
      .fn()
      .mockResolvedValue({ behavior: 'deny', message: 'Ask mode is read-only' });
    const hooks = buildSessionPermissionHooks(decide);
    const result = await hooks.PreToolUse![0].hooks[0](input, 'tool-1', {
      signal: new AbortController().signal,
    });
    expect(decide).toHaveBeenCalledWith(
      'Write',
      input.tool_input,
      expect.objectContaining({ toolUseID: 'tool-1' }),
    );
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Ask mode is read-only',
      },
    });
  });
  it('passes approved rewritten inputs to the SDK', async () => {
    const hooks = buildSessionPermissionHooks(
      vi.fn().mockResolvedValue({
        behavior: 'allow',
        updatedInput: { file_path: '/worktree/a', content: 'a' },
      }),
    );
    expect(
      await hooks.PreToolUse![0].hooks[0](input, 'tool-1', {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: { file_path: '/worktree/a' },
      },
    });
  });
  it('leaves structured questions to the SDK callback to return answers', async () => {
    const decide = vi.fn();
    const hooks = buildSessionPermissionHooks(decide);
    expect(
      await hooks.PreToolUse![0].hooks[0]({ ...input, tool_name: 'AskUserQuestion' }, 'q', {
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    expect(decide).not.toHaveBeenCalled();
  });
  it('preserves project hooks without letting them remove the host gate', () => {
    const project = vi.fn();
    const hooks = buildSessionPermissionHooks(vi.fn(), {
      PreToolUse: [{ hooks: [project] }],
      Stop: [{ hooks: [project] }],
    });
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.Stop![0].hooks).toEqual([project]);
  });
  it('runs matching project rewrites sequentially before the authoritative gate', async () => {
    const first = vi.fn().mockResolvedValue({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { file_path: '/outside/a', content: 'changed' },
        additionalContext: 'project context',
      },
    });
    const second = vi.fn().mockResolvedValue({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    const unmatched = vi.fn();
    const decide = vi.fn().mockResolvedValue({ behavior: 'deny', message: 'Outside workspace' });
    const hooks = buildSessionPermissionHooks(decide, {
      PreToolUse: [
        { matcher: '^Write$', hooks: [first, second] },
        { matcher: '^Read$', hooks: [unmatched] },
      ],
    });
    const result = await hooks.PreToolUse![0].hooks[0](input, 'tool', {
      signal: new AbortController().signal,
    });
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ tool_input: { file_path: '/outside/a', content: 'changed' } }),
      'tool',
      expect.anything(),
    );
    expect(unmatched).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith(
      'Write',
      { file_path: '/outside/a', content: 'changed' },
      expect.anything(),
    );
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', additionalContext: 'project context' },
    });
  });
  it.each([
    {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'project denial',
      },
    },
    { decision: 'block', reason: 'project block' },
    { continue: false, stopReason: 'project stop' },
    { async: true },
  ])('fails closed on project denial or unsupported async output %j', async (output) => {
    const decide = vi.fn();
    const hooks = buildSessionPermissionHooks(decide, {
      PreToolUse: [{ hooks: [vi.fn().mockResolvedValue(output)] }],
    });
    const result = await hooks.PreToolUse![0].hooks[0](input, 'tool', {
      signal: new AbortController().signal,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
  it('retains project ask as a forced shared approval', async () => {
    const decide = vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: input.tool_input });
    const hooks = buildSessionPermissionHooks(decide, {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            vi.fn().mockResolvedValue({
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
            }),
          ],
        },
      ],
    });
    await hooks.PreToolUse![0].hooks[0](input, 'tool', { signal: new AbortController().signal });
    expect(decide).toHaveBeenCalledWith(
      'Write',
      input.tool_input,
      expect.objectContaining({ forcePrompt: true }),
    );
  });
  it('processes project hooks for user questions without consuming the SDK answer callback', async () => {
    const decide = vi.fn();
    const hooks = buildSessionPermissionHooks(decide, {
      PreToolUse: [
        {
          hooks: [
            vi.fn().mockResolvedValue({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: { questions: [] },
                additionalContext: 'question context',
              },
            }),
          ],
        },
      ],
    });
    const result = await hooks.PreToolUse![0].hooks[0](
      { ...input, tool_name: 'AskUserQuestion' },
      'tool',
      { signal: new AbortController().signal },
    );
    expect(decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      hookSpecificOutput: {
        updatedInput: { questions: [] },
        additionalContext: 'question context',
      },
    });
  });
  it('explains user authorization and live host permissions', () => {
    expect(SESSION_PERMISSION_INSTRUCTIONS).toContain('already authorized');
    expect(SESSION_PERMISSION_INSTRUCTIONS).toContain('current');
    expect(HOST_TOOL_INSTRUCTIONS).toContain('read-only');
    expect(HOST_TOOL_INSTRUCTIONS).toContain('Write');
    expect(HOST_TOOL_INSTRUCTIONS).toContain('Bash');
  });
});

it('fails closed on policy errors and allows time for the approval card', async () => {
  const hooks = buildSessionPermissionHooks(
    vi.fn().mockRejectedValue(new Error('registry failed')),
  );
  expect(hooks.PreToolUse![0].timeout).toBeGreaterThan(120);
  const result = await hooks.PreToolUse![0].hooks[0](
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'touch x' },
    },
    'tool-2',
    { signal: new AbortController().signal },
  );
  expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});
