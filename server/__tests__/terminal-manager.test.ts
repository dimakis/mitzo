import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty before importing terminal-manager
const mockPtyProcess = {
  pid: 12345,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ ...mockPtyProcess })),
}));

import * as pty from 'node-pty';
import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  destroyTerminal,
  destroySessionTerminals,
  destroyConnectionTerminals,
  getTerminal,
  getTerminalOwner,
  listTerminals,
  setTerminalCallbacks,
  clearTerminalCallbacks,
} from '../terminal-manager.js';

// Track created terminal IDs for cleanup
let createdIds: string[] = [];

function createTestTerminal(
  sessionId = 'sess-1',
  connectionId = 'conn-1',
  cwd = '/tmp/test',
  opts?: Parameters<typeof createTerminal>[3],
) {
  const info = createTerminal(sessionId, connectionId, cwd, opts);
  createdIds.push(info.id);
  return info;
}

beforeEach(() => {
  vi.clearAllMocks();
  createdIds = [];
  // Reset mock to return fresh objects each call
  vi.mocked(pty.spawn).mockImplementation(
    () =>
      ({
        ...mockPtyProcess,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      }) as unknown as pty.IPty,
  );
});

afterEach(() => {
  // Clean up all terminals created during the test
  for (const id of createdIds) {
    try {
      destroyTerminal(id);
    } catch {
      // already destroyed
    }
  }
  createdIds = [];
});

// ─── createTerminal ─────────────────────────────────────────────────────────

describe('createTerminal', () => {
  it('returns terminal info with id, pid, dimensions, cwd', () => {
    const info = createTestTerminal('sess-1', 'conn-1', '/tmp/test');

    expect(info.id).toMatch(/^term-[0-9a-f-]{36}$/);
    expect(info.sessionId).toBe('sess-1');
    expect(info.pid).toBe(12345);
    expect(info.cols).toBe(80);
    expect(info.rows).toBe(24);
    expect(info.cwd).toBe('/tmp/test');
    expect(info.createdAt).toBeGreaterThan(0);
  });

  it('respects custom cols and rows', () => {
    const info = createTestTerminal('sess-1', 'conn-1', '/tmp', { cols: 120, rows: 40 });

    expect(info.cols).toBe(120);
    expect(info.rows).toBe(40);
    expect(pty.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
  });

  it('spawns with safe environment (no process.env leak)', () => {
    // Set a dangerous env var
    process.env.ANTHROPIC_API_KEY = 'secret-key-123';
    createTestTerminal();

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    const env = spawnCall[2].env as Record<string, string>;

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('passes safe env vars through (PATH, HOME, LANG, LC_*)', () => {
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.LC_ALL = 'en_US.UTF-8';

    createTestTerminal();

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    const env = spawnCall[2].env as Record<string, string>;

    expect(env.PATH).toBe(origPath);
    expect(env.HOME).toBe(origHome);
    expect(env.LC_ALL).toBe('en_US.UTF-8');
  });

  it('enforces per-session limit (5)', () => {
    for (let i = 0; i < 5; i++) {
      createTestTerminal('sess-limit', `conn-${i}`, '/tmp');
    }

    expect(() => createTestTerminal('sess-limit', 'conn-6', '/tmp')).toThrow(
      'Session terminal limit reached (5)',
    );
  });

  it('enforces global limit (50)', () => {
    // Create 50 terminals across different sessions to avoid per-session limit
    for (let i = 0; i < 50; i++) {
      createTestTerminal(`sess-global-${i}`, `conn-${i}`, '/tmp');
    }

    expect(() => createTestTerminal('sess-new', 'conn-new', '/tmp')).toThrow(
      'Global terminal limit reached (50)',
    );
  });

  it('accepts onData/onExit callbacks and wires them before spawn output', () => {
    const onData = vi.fn();
    const onExit = vi.fn();

    const info = createTestTerminal('sess-1', 'conn-1', '/tmp', { onData, onExit });

    // The managed terminal should have callbacks set before proc.onData fires
    // Verify by simulating PTY output via the onData handler registered on the mock
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;
    const registeredOnData = spawnResult.onData.mock.calls[0][0];
    registeredOnData('hello from shell');

    expect(onData).toHaveBeenCalledWith('hello from shell');

    // Simulate exit
    const registeredOnExit = spawnResult.onExit.mock.calls[0][0];
    registeredOnExit({ exitCode: 0, signal: 15 });

    expect(onExit).toHaveBeenCalledWith(0, 15);
    expect(info.id).toBeTruthy();
  });
});

// ─── writeTerminal ──────────────────────────────────────────────────────────

describe('writeTerminal', () => {
  it('writes data to the PTY process', () => {
    const info = createTestTerminal();
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;

    expect(writeTerminal(info.id, 'ls -la\n')).toBe(true);
    expect(spawnResult.write).toHaveBeenCalledWith('ls -la\n');
  });

  it('returns false for unknown terminal ID', () => {
    expect(writeTerminal('nonexistent', 'data')).toBe(false);
  });
});

// ─── resizeTerminal ─────────────────────────────────────────────────────────

describe('resizeTerminal', () => {
  it('resizes the PTY process', () => {
    const info = createTestTerminal();
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;

    expect(resizeTerminal(info.id, 200, 50)).toBe(true);
    expect(spawnResult.resize).toHaveBeenCalledWith(200, 50);
  });

  it('returns false for unknown terminal ID', () => {
    expect(resizeTerminal('nonexistent', 80, 24)).toBe(false);
  });
});

// ─── destroyTerminal ────────────────────────────────────────────────────────

describe('destroyTerminal', () => {
  it('kills the process and removes from map', () => {
    const info = createTestTerminal();
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;

    expect(destroyTerminal(info.id)).toBe(true);
    expect(spawnResult.kill).toHaveBeenCalled();
    expect(getTerminal(info.id)).toBeNull();
    // Remove from cleanup list since already destroyed
    createdIds = createdIds.filter((id) => id !== info.id);
  });

  it('returns false for unknown terminal ID', () => {
    expect(destroyTerminal('nonexistent')).toBe(false);
  });

  it('handles kill() throwing (process already exited)', () => {
    const info = createTestTerminal();
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;
    spawnResult.kill.mockImplementation(() => {
      throw new Error('Process already dead');
    });

    // Should not throw — try-catch handles it
    expect(destroyTerminal(info.id)).toBe(true);
    expect(getTerminal(info.id)).toBeNull();
    createdIds = createdIds.filter((id) => id !== info.id);
  });
});

// ─── destroySessionTerminals ────────────────────────────────────────────────

describe('destroySessionTerminals', () => {
  it('destroys all terminals for a session', () => {
    createTestTerminal('sess-a', 'conn-1', '/tmp');
    createTestTerminal('sess-a', 'conn-2', '/tmp');
    createTestTerminal('sess-b', 'conn-3', '/tmp');

    const count = destroySessionTerminals('sess-a');

    expect(count).toBe(2);
    expect(listTerminals('sess-a')).toHaveLength(0);
    expect(listTerminals('sess-b')).toHaveLength(1);
    // Update cleanup list
    createdIds = listTerminals().map((t) => t.id);
  });

  it('returns 0 for unknown session', () => {
    expect(destroySessionTerminals('nonexistent')).toBe(0);
  });

  it('continues cleanup even if kill() throws on one terminal', () => {
    createTestTerminal('sess-err', 'conn-1', '/tmp');
    createTestTerminal('sess-err', 'conn-2', '/tmp');

    // Make the first spawned process throw on kill
    const firstResult = vi.mocked(pty.spawn).mock.results[0].value;
    firstResult.kill.mockImplementation(() => {
      throw new Error('Process already dead');
    });

    const count = destroySessionTerminals('sess-err');
    expect(count).toBe(2);
    expect(listTerminals('sess-err')).toHaveLength(0);
    createdIds = [];
  });
});

// ─── destroyConnectionTerminals ─────────────────────────────────────────────

describe('destroyConnectionTerminals', () => {
  it('destroys all terminals for a connection', () => {
    createTestTerminal('sess-1', 'conn-target', '/tmp');
    createTestTerminal('sess-2', 'conn-target', '/tmp');
    createTestTerminal('sess-1', 'conn-other', '/tmp');

    const count = destroyConnectionTerminals('conn-target');

    expect(count).toBe(2);
    expect(listTerminals()).toHaveLength(1);
    createdIds = listTerminals().map((t) => t.id);
  });

  it('returns 0 for unknown connection', () => {
    expect(destroyConnectionTerminals('nonexistent')).toBe(0);
  });

  it('continues cleanup even if kill() throws', () => {
    createTestTerminal('sess-1', 'conn-err', '/tmp');
    createTestTerminal('sess-2', 'conn-err', '/tmp');

    const firstResult = vi.mocked(pty.spawn).mock.results[0].value;
    firstResult.kill.mockImplementation(() => {
      throw new Error('gone');
    });

    const count = destroyConnectionTerminals('conn-err');
    expect(count).toBe(2);
    createdIds = [];
  });
});

// ─── getTerminal / getTerminalOwner / listTerminals ─────────────────────────

describe('getTerminal', () => {
  it('returns terminal info for valid ID', () => {
    const info = createTestTerminal('sess-1', 'conn-1', '/tmp/cwd');
    const retrieved = getTerminal(info.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(info.id);
    expect(retrieved!.sessionId).toBe('sess-1');
    expect(retrieved!.cwd).toBe('/tmp/cwd');
  });

  it('returns null for unknown ID', () => {
    expect(getTerminal('nonexistent')).toBeNull();
  });
});

describe('getTerminalOwner', () => {
  it('returns connectionId for valid terminal', () => {
    const info = createTestTerminal('sess-1', 'conn-owner', '/tmp');
    expect(getTerminalOwner(info.id)).toBe('conn-owner');
  });

  it('returns null for unknown terminal', () => {
    expect(getTerminalOwner('nonexistent')).toBeNull();
  });
});

describe('listTerminals', () => {
  it('lists all terminals when no filter', () => {
    createTestTerminal('sess-1', 'conn-1', '/tmp');
    createTestTerminal('sess-2', 'conn-2', '/tmp');

    expect(listTerminals()).toHaveLength(2);
  });

  it('filters by sessionId', () => {
    createTestTerminal('sess-a', 'conn-1', '/tmp');
    createTestTerminal('sess-a', 'conn-2', '/tmp');
    createTestTerminal('sess-b', 'conn-3', '/tmp');

    expect(listTerminals('sess-a')).toHaveLength(2);
    expect(listTerminals('sess-b')).toHaveLength(1);
    expect(listTerminals('sess-c')).toHaveLength(0);
  });
});

// ─── setTerminalCallbacks / clearTerminalCallbacks ──────────────────────────

describe('setTerminalCallbacks', () => {
  it('sets callbacks on existing terminal', () => {
    const info = createTestTerminal();
    const onData = vi.fn();
    const onExit = vi.fn();

    expect(setTerminalCallbacks(info.id, onData, onExit)).toBe(true);

    // Trigger the PTY onData handler to verify callback is wired
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;
    const registeredOnData = spawnResult.onData.mock.calls[0][0];
    registeredOnData('test output');

    expect(onData).toHaveBeenCalledWith('test output');
  });

  it('returns false for unknown terminal', () => {
    expect(setTerminalCallbacks('nonexistent', vi.fn(), vi.fn())).toBe(false);
  });
});

describe('clearTerminalCallbacks', () => {
  it('clears callbacks on existing terminal', () => {
    const onData = vi.fn();
    const info = createTestTerminal('sess-1', 'conn-1', '/tmp', { onData });

    expect(clearTerminalCallbacks(info.id)).toBe(true);

    // Output after clearing should not reach the callback
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;
    const registeredOnData = spawnResult.onData.mock.calls[0][0];
    registeredOnData('after clear');

    // onData was called once during creation output, but clearTerminalCallbacks nulls it
    // The managed.onData?.() will be a no-op since onData is null
    expect(onData).not.toHaveBeenCalledWith('after clear');
  });

  it('returns false for unknown terminal', () => {
    expect(clearTerminalCallbacks('nonexistent')).toBe(false);
  });
});

// ─── onExit auto-cleanup ────────────────────────────────────────────────────

describe('onExit auto-cleanup', () => {
  it('removes terminal from map when PTY process exits naturally', () => {
    const info = createTestTerminal('sess-1', 'conn-1', '/tmp');

    // Terminal should exist
    expect(getTerminal(info.id)).not.toBeNull();

    // Simulate PTY process exit via the onExit handler
    const spawnResult = vi.mocked(pty.spawn).mock.results[0].value;
    const registeredOnExit = spawnResult.onExit.mock.calls[0][0];
    registeredOnExit({ exitCode: 0, signal: 0 });

    // Terminal should be auto-removed
    expect(getTerminal(info.id)).toBeNull();
    expect(listTerminals('sess-1')).toHaveLength(0);

    // Remove from cleanup list since it auto-cleaned
    createdIds = createdIds.filter((id) => id !== info.id);
  });
});

// ─── environment variable filtering ─────────────────────────────────────────

describe('buildSafeEnv (via createTerminal)', () => {
  it('passes LC_* prefixed vars through', () => {
    process.env.LC_CTYPE = 'UTF-8';
    process.env.LC_MESSAGES = 'en_US.UTF-8';
    createTestTerminal();

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    const env = spawnCall[2].env as Record<string, string>;

    expect(env.LC_CTYPE).toBe('UTF-8');
    expect(env.LC_MESSAGES).toBe('en_US.UTF-8');
  });

  it('passes XDG_* prefixed vars through', () => {
    process.env.XDG_CONFIG_HOME = '/home/user/.config';
    process.env.XDG_DATA_HOME = '/home/user/.local/share';
    createTestTerminal();

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    const env = spawnCall[2].env as Record<string, string>;

    expect(env.XDG_CONFIG_HOME).toBe('/home/user/.config');
    expect(env.XDG_DATA_HOME).toBe('/home/user/.local/share');

    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  it('merges extra env vars from opts', () => {
    createTestTerminal('sess-1', 'conn-1', '/tmp', {
      env: { CUSTOM_VAR: 'custom-value' },
    });

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    const env = spawnCall[2].env as Record<string, string>;

    expect(env.CUSTOM_VAR).toBe('custom-value');
  });

  it('strips dangerous env vars (DATABASE_URL, secrets, etc.)', () => {
    process.env.DATABASE_URL = 'postgres://secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.JWT_SECRET = 'jwt-secret';
    createTestTerminal();

    const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
    const env = spawnCall[2].env as Record<string, string>;

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();

    delete process.env.DATABASE_URL;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.JWT_SECRET;
  });
});
