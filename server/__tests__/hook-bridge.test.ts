import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSessionPermissionHooks } from '../session-permission-policy.js';
import {
  parseSettingsHooks,
  expandEnvVars,
  mapHookOutput,
  createCommandCallback,
  loadProjectHooks,
} from '../hook-bridge.js';

const TEST_DIR = join(tmpdir(), `mitzo-hooks-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(join(TEST_DIR, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function writeSettings(content: object): string {
  const path = join(TEST_DIR, '.claude', 'settings.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

// --- parseSettingsHooks ---

describe('parseSettingsHooks', () => {
  it('returns hooks from a valid settings.json', () => {
    const path = writeSettings({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'echo hello' }],
          },
        ],
      },
    });

    const hooks = parseSettingsHooks(path);
    expect(hooks).not.toBeNull();
    expect(hooks!.SessionStart).toHaveLength(1);
    expect(hooks!.SessionStart![0].matcher).toBe('startup');
    expect(hooks!.SessionStart![0].hooks).toHaveLength(1);
  });

  it('returns null for missing file', () => {
    expect(parseSettingsHooks('/nonexistent/settings.json')).toBeNull();
  });

  it('rejects malformed configuration visibly', () => {
    const path = join(TEST_DIR, '.claude', 'settings.json');
    writeFileSync(path, '{ not valid');
    expect(() => parseSettingsHooks(path)).toThrow('Project hook configuration is invalid');
  });

  it('returns null for settings without hooks key', () => {
    const path = writeSettings({ permissions: {} });
    expect(parseSettingsHooks(path)).toBeNull();
  });

  it('handles multiple hook events', () => {
    const path = writeSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo tool' }] }],
      },
    });

    const hooks = parseSettingsHooks(path);
    expect(hooks).not.toBeNull();
    expect(Object.keys(hooks!)).toEqual(['SessionStart', 'PreToolUse']);
  });

  it('handles multiple matchers per event', () => {
    const path = writeSettings({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo a' }] },
          { matcher: 'resume', hooks: [{ type: 'command', command: 'echo b' }] },
        ],
      },
    });

    const hooks = parseSettingsHooks(path);
    expect(hooks!.SessionStart).toHaveLength(2);
  });
});

// --- expandEnvVars ---

describe('expandEnvVars', () => {
  it('expands $CLAUDE_PROJECT_DIR', () => {
    expect(
      expandEnvVars('$CLAUDE_PROJECT_DIR/hooks/run.sh', { CLAUDE_PROJECT_DIR: '/my/project' }),
    ).toBe('/my/project/hooks/run.sh');
  });

  it('expands ${VAR_NAME} syntax', () => {
    expect(expandEnvVars('${HOME}/bin', { HOME: '/Users/test' })).toBe('/Users/test/bin');
  });

  it('leaves unknown variables unchanged', () => {
    expect(expandEnvVars('$UNKNOWN_VAR/path', {})).toBe('$UNKNOWN_VAR/path');
  });

  it('handles multiple variables in one string', () => {
    const env = { A: 'alpha', B: 'beta' };
    expect(expandEnvVars('$A and $B', env)).toBe('alpha and beta');
  });

  it('handles empty string', () => {
    expect(expandEnvVars('', {})).toBe('');
  });
});

// --- mapHookOutput ---

describe('mapHookOutput', () => {
  it('wraps additionalContext in hookSpecificOutput', () => {
    const result = mapHookOutput({ additionalContext: 'boot context here' }, 'SessionStart');
    expect(result.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'boot context here',
    });
  });

  it('passes through top-level SDK fields', () => {
    const result = mapHookOutput({ continue: true, decision: 'approve' as const }, 'PreToolUse');
    expect(result.continue).toBe(true);
    expect(result.decision).toBe('approve');
  });

  it('handles mixed top-level and specific fields', () => {
    const result = mapHookOutput(
      { continue: true, additionalContext: 'context', watchPaths: ['/a'] },
      'SessionStart',
    );
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'context',
      watchPaths: ['/a'],
    });
  });

  it('returns empty object for empty input', () => {
    expect(mapHookOutput({}, 'SessionStart')).toEqual({});
  });

  it('works with non-SessionStart event names', () => {
    const result = mapHookOutput({ decision: 'block' as const, reason: 'denied' }, 'PreToolUse');
    expect(result.decision).toBe('block');
    expect(result.reason).toBe('denied');
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});

// --- createCommandCallback ---

describe('createCommandCallback', () => {
  it('returns parsed JSON from a successful command', async () => {
    const cb = createCommandCallback('echo \'{"additionalContext":"test"}\'', TEST_DIR, 5000);
    const result = await cb({} as never, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'unknown',
        additionalContext: 'test',
      },
    });
  });

  it('stops visibly when command exits non-zero', async () => {
    const cb = createCommandCallback('exit 1', TEST_DIR, 5000);
    const result = await cb({} as never, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toMatchObject({
      continue: false,
      stopReason: expect.stringContaining('failed'),
    });
  });

  it('stops visibly when command outputs invalid JSON', async () => {
    const cb = createCommandCallback('echo "not json"', TEST_DIR, 5000);
    const result = await cb({} as never, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toMatchObject({
      continue: false,
      stopReason: expect.stringContaining('output'),
    });
  });

  it('returns empty object when command outputs nothing', async () => {
    const cb = createCommandCallback('true', TEST_DIR, 5000);
    const result = await cb({} as never, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toEqual({});
  });

  it('uses the provided hookEventName from input', async () => {
    const cb = createCommandCallback('echo \'{"additionalContext":"ctx"}\'', TEST_DIR, 5000);
    const input = { hook_event_name: 'SessionStart' } as never;
    const result = await cb(input, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'ctx',
      },
    });
  });

  it('stops when aborted', { timeout: 3000 }, async () => {
    const controller = new AbortController();
    // Replace the shell so cancellation closes the child output pipes immediately.
    const cb = createCommandCallback('exec sleep 10', TEST_DIR, 10000);
    const promise = cb({} as never, undefined, { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result).toMatchObject({ continue: false });
  });
});

// --- loadProjectHooks ---

describe('loadProjectHooks', () => {
  it('returns SDK hooks from a project with settings.json', () => {
    writeSettings({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'echo \'{"additionalContext":"hi"}\'' }],
          },
        ],
      },
    });

    const hooks = loadProjectHooks(TEST_DIR);
    expect(hooks).toBeDefined();
    expect(hooks!.SessionStart).toHaveLength(1);
    expect(hooks!.SessionStart![0].matcher).toBe('startup');
    expect(hooks!.SessionStart![0].hooks).toHaveLength(1);
    expect(typeof hooks!.SessionStart![0].hooks[0]).toBe('function');
  });

  it('returns undefined when no settings.json exists', () => {
    rmSync(join(TEST_DIR, '.claude'), { recursive: true, force: true });
    expect(loadProjectHooks(TEST_DIR)).toBeUndefined();
  });

  it('returns undefined when settings has no hooks', () => {
    writeSettings({ permissions: {} });
    expect(loadProjectHooks(TEST_DIR)).toBeUndefined();
  });

  it('preserves timeout from settings', () => {
    writeSettings({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'echo test' }],
            timeout: 30,
          },
        ],
      },
    });

    const hooks = loadProjectHooks(TEST_DIR);
    expect(hooks!.SessionStart![0].timeout).toBe(30);
  });
});

it('does not expand or inherit controller GitHub credentials in project hooks', async () => {
  vi.stubEnv('GH_TOKEN', 'controller-only');
  vi.stubEnv('GITHUB_TOKEN', 'controller-fallback');
  writeSettings({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `printf '{"additionalContext":"%s|%s"}' "$GH_TOKEN" "$GITHUB_TOKEN"`,
            },
          ],
        },
      ],
    },
  });
  const hooks = loadProjectHooks(TEST_DIR)!;
  const callback = hooks.SessionStart![0].hooks[0];
  const input = { hook_event_name: 'SessionStart' } as Parameters<typeof callback>[0];
  expect(await callback(input, undefined, { signal: new AbortController().signal })).toMatchObject({
    hookSpecificOutput: { additionalContext: '|' },
  });
  const direct = createCommandCallback(
    `printf '{"additionalContext":"%s|%s"}' "$GH_TOKEN" "$GITHUB_TOKEN"`,
    TEST_DIR,
    5000,
  );
  expect(await direct(input, undefined, { signal: new AbortController().signal })).toMatchObject({
    hookSpecificOutput: { additionalContext: '|' },
  });
  expect(process.env.GH_TOKEN).toBe('controller-only');
});

it('routes project hook commands through the optional protected runner, preserving input/env/timeout/output', async () => {
  writeSettings({
    hooks: {
      SessionStart: [{ timeout: 2, hooks: [{ type: 'command', command: 'synthetic $VALUE' }] }],
    },
  });
  const runner = vi.fn().mockResolvedValue({
    stdout: '{"additionalContext":"protected context"}',
    stderr: 'synthetic diagnostic',
  });
  const hooks = loadProjectHooks(
    TEST_DIR,
    { VALUE: 'project value', GH_TOKEN: 'excluded controller value' },
    runner,
  )!;
  const callback = hooks.SessionStart![0].hooks[0];
  const input = { hook_event_name: 'SessionStart' } as Parameters<typeof callback>[0];
  const signal = new AbortController().signal;
  await expect(callback(input, undefined, { signal })).resolves.toMatchObject({
    hookSpecificOutput: { additionalContext: 'protected context' },
  });
  expect(runner).toHaveBeenCalledWith(
    '/bin/sh',
    ['-c', 'synthetic project value'],
    expect.objectContaining({
      cwd: TEST_DIR,
      timeout: 2000,
      input: JSON.stringify(input),
      signal,
      env: { VALUE: 'project value', CLAUDE_PROJECT_DIR: TEST_DIR },
    }),
  );
});
it('stops on protected command failure, invalid output and already aborted callbacks', async () => {
  const runner = vi.fn().mockRejectedValue(new Error('synthetic protected failure'));
  const callback = createCommandCallback('synthetic', TEST_DIR, 1000, {}, runner);
  const signal = new AbortController().signal;
  expect(await callback({} as never, undefined, { signal })).toMatchObject({ continue: false });
  runner.mockResolvedValue({ stdout: 'invalid JSON', stderr: '' } as never);
  expect(await callback({} as never, undefined, { signal })).toMatchObject({ continue: false });
  const controller = new AbortController();
  controller.abort();
  expect(await callback({} as never, undefined, { signal: controller.signal })).toMatchObject({
    continue: false,
  });
  expect(runner).toHaveBeenCalledTimes(2);
});

it.each([
  { UnknownEvent: [{ hooks: [{ type: 'command', command: 'true' }] }] },
  { PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'approve' }] }] },
  { PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'true' }] }] },
  { PreToolUse: [{ timeout: -1, hooks: [{ type: 'command', command: 'true' }] }] },
  { PreToolUse: [{ hooks: [{ type: 'command', command: 'true', async: true }] }] },
])('rejects unsupported project hook configuration before callbacks can run: %j', (hooks) => {
  writeSettings({ hooks });
  expect(() => loadProjectHooks(TEST_DIR)).toThrow('Project hook configuration is invalid');
});

it.each(['deny', 'ask', 'allow'] as const)(
  'delivers canonical %s and rewritten input through the real permission consumer',
  async (permissionDecision) => {
    const updatedInput = { file_path: '/repo/checked', content: 'checked' };
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision,
          permissionDecisionReason: 'Project policy',
          updatedInput,
        },
      }),
      stderr: '',
    });
    writeSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'synthetic' }] }] },
    });
    const decide = vi
      .fn()
      .mockResolvedValue({ behavior: 'deny', message: 'Ask mode is read-only' });
    const hook = buildSessionPermissionHooks(decide, loadProjectHooks(TEST_DIR, {}, runner))
      .PreToolUse![0].hooks[0];
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: TEST_DIR,
        tool_name: 'Write',
        tool_use_id: 't',
        tool_input: { file_path: '/repo/original' },
      },
      't',
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    if (permissionDecision === 'deny') expect(decide).not.toHaveBeenCalled();
    else
      expect(decide).toHaveBeenCalledWith(
        'Write',
        updatedInput,
        expect.objectContaining({ ...(permissionDecision === 'ask' ? { forcePrompt: true } : {}) }),
      );
  },
);

it.each(
  [
    null,
    [],
    'text',
    { async: true },
    { continue: 'false' },
    { hookSpecificOutput: { permissionDecision: 'unknown' } },
    { hookSpecificOutput: { updatedInput: [] } },
    { permissionDecision: 'allow', hookSpecificOutput: { permissionDecision: 'deny' } },
    { hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'allow' } },
  ].map((output) => ({ output })),
)(
  'blocks invalid or unsupported output through the permission consumer: %j',
  async ({ output }) => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify(output), stderr: '' });
    const decide = vi.fn();
    const hook = buildSessionPermissionHooks(decide, {
      PreToolUse: [{ hooks: [createCommandCallback('synthetic', TEST_DIR, 1000, {}, runner)] }],
    }).PreToolUse![0].hooks[0];
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: TEST_DIR,
        tool_name: 'Write',
        tool_use_id: 't',
        tool_input: {},
      },
      't',
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      continue: false,
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(decide).not.toHaveBeenCalled();
  },
);
