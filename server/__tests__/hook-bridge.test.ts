import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

  it('returns null for malformed JSON', () => {
    const path = join(TEST_DIR, '.claude', 'settings.json');
    writeFileSync(path, '{ not valid');
    expect(parseSettingsHooks(path)).toBeNull();
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

  it('returns empty object when command exits non-zero', async () => {
    const cb = createCommandCallback('exit 1', TEST_DIR, 5000);
    const result = await cb({} as never, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toEqual({});
  });

  it('returns empty object when command outputs invalid JSON', async () => {
    const cb = createCommandCallback('echo "not json"', TEST_DIR, 5000);
    const result = await cb({} as never, undefined, { signal: AbortSignal.timeout(5000) });
    expect(result).toEqual({});
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

  it('returns empty object when aborted', async () => {
    const controller = new AbortController();
    // sleep command that we'll abort immediately
    const cb = createCommandCallback('sleep 10', TEST_DIR, 10000);
    const promise = cb({} as never, undefined, { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result).toEqual({});
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
