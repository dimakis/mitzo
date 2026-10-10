import Database from 'better-sqlite3';
import { TerminalSessionMissing } from '../terminal-errors.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalStore,
  TerminalService,
  type TerminalBackend,
  type TerminalTarget,
} from '../terminal-service.js';

describe('operator terminals', () => {
  let db: Database.Database;
  let target: TerminalTarget;
  let onData: (data: string) => void;
  let onExit: (reason?: 'disconnected') => void;
  const process = { write: vi.fn(), resize: vi.fn(), detach: vi.fn() };
  let backend: TerminalBackend;
  let service: TerminalService;
  let pendingResolution: Promise<void> | undefined;
  beforeEach(() => {
    pendingResolution = undefined;
    db = new Database(':memory:');
    target = { kind: 'host', label: 'Your Mac', cwd: '/home/operator', identity: 'host:v1' };
    process.write.mockReset();
    process.resize.mockReset();
    process.detach.mockReset();
    backend = {
      start: vi.fn(async (_record, _resume, callbacks) => {
        onData = callbacks.data;
        onExit = callbacks.exit;
        return process;
      }),
      end: vi.fn(async () => {}),
    };
    service = new TerminalService(new TerminalStore(db), {
      resolve: async (request) => {
        await pendingResolution;
        return {
          ...target,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        };
      },
      backend,
    });
  });
  afterEach(() => {
    service.detachAll();
    db.close();
  });

  it('reuses an operator’s terminal after navigation without restarting its shell', async () => {
    const first = await service.open('operator-a', {});
    const unsubscribe = await service.subscribe('operator-a', first.id, vi.fn());
    unsubscribe();
    const resumed = await service.open('operator-a', {});
    expect(resumed.id).toBe(first.id);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(process.detach).not.toHaveBeenCalled();
  });
  it('retains bounded output while the phone disconnects and sends a replay on reattach', async () => {
    const terminal = await service.open('operator-a', {});
    onData('prompt');
    onData('x'.repeat(300_000));
    const listener = vi.fn();
    await service.subscribe('operator-a', terminal.id, listener);
    const snapshot = listener.mock.calls[0][0];
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.data.length).toBeLessThanOrEqual(128 * 1024);
    onData('new output');
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'output', data: 'new output' });
  });
  it('refuses every operation from another login session', async () => {
    const terminal = await service.open('operator-a', {});
    expect(() => service.get('operator-b', terminal.id)).toThrow('Terminal unavailable');
    await expect(service.write('operator-b', terminal.id, 'whoami\r')).rejects.toThrow(
      'Terminal unavailable',
    );
    await expect(service.subscribe('operator-b', terminal.id, vi.fn())).rejects.toThrow(
      'Terminal unavailable',
    );
    await expect(service.end('operator-b', terminal.id)).rejects.toThrow('Terminal unavailable');
    expect(process.write).not.toHaveBeenCalled();
    expect(backend.end).not.toHaveBeenCalled();
  });
  it('does not spawn a host fallback when resolving a sandbox fails', async () => {
    service = new TerminalService(new TerminalStore(db), {
      resolve: async () => {
        throw Error('Sandbox unavailable');
      },
      backend,
    });
    await expect(service.open('operator-a', { sessionId: 'chat-a' })).rejects.toThrow(
      'Sandbox unavailable',
    );
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('pins a sandbox identity and rejects input after its binding changes', async () => {
    target = {
      kind: 'sandbox',
      label: 'Chat A',
      cwd: '/sandbox/workspaces/task',
      identity: 'sandbox-original',
    };
    const terminal = await service.open('operator-a', { sessionId: 'chat-a' });
    target.identity = 'replacement-sandbox';
    await expect(service.write('operator-a', terminal.id, 'pwd\r')).rejects.toThrow(
      'Terminal environment changed',
    );
    expect(process.write).not.toHaveBeenCalled();
  });
  it('rechecks authorization before input and bounds terminal dimensions', async () => {
    const terminal = await service.open('operator-a', {});
    await service.write('operator-a', terminal.id, 'pwd\r');
    expect(process.write).toHaveBeenCalledWith('pwd\r');
    await expect(service.resize('operator-a', terminal.id, 99999, 24)).rejects.toThrow(
      'Invalid terminal size',
    );
    expect(process.resize).not.toHaveBeenCalled();
  });
  it('serializes concurrent opens and limits operator resources', async () => {
    const terminals = await Promise.all([
      service.open('operator-a', {}),
      service.open('operator-a', {}),
    ]);
    expect(terminals[0].id).toBe(terminals[1].id);
    expect(backend.start).toHaveBeenCalledTimes(1);
    for (let index = 1; index < 5; index++) {
      target.identity = `host:${index}`;
      await service.open('operator-a', {});
    }
    target.identity = 'host:too-many';
    await expect(service.open('operator-a', {})).rejects.toThrow('Terminal limit reached');
  });
  it('persists ownership and resumes only a recorded original terminal after server restart', async () => {
    const terminal = await service.open('operator-a', {});
    service.detachAll();
    service = new TerminalService(new TerminalStore(db), { resolve: async () => target, backend });
    const resumed = await service.open('operator-a', {});
    expect(resumed.id).toBe(terminal.id);
    expect(backend.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: terminal.id }),
      true,
      expect.anything(),
    );
  });
  it('ends only the selected original terminal and records natural exits', async () => {
    const terminal = await service.open('operator-a', {});
    onExit();
    expect(service.get('operator-a', terminal.id).state).toBe('ended');
    const next = await service.open('operator-a', {});
    expect(next.id).not.toBe(terminal.id);
    await service.end('operator-a', next.id);
    expect(backend.end).toHaveBeenCalledWith(expect.objectContaining({ id: next.id }));
    expect(service.get('operator-a', next.id).state).toBe('ended');
  });
  it('does not exhaust running-shell capacity after failed starts', async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      vi.mocked(backend.start).mockRejectedValueOnce(Error('tmux missing'));
      await expect(service.open('operator-a', {})).rejects.toThrow('could not be opened');
    }
    expect((await service.open('operator-a', {})).state).toBe('running');
  });
  it('does not deliver queued input after logout or expiry during environment verification', async () => {
    const terminal = await service.open('operator-a', {});
    let release!: () => void;
    pendingResolution = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const writing = service.write('operator-a', terminal.id, 'whoami\r', {
      signal: controller.signal,
      expiresAt: Date.now() + 60000,
    });
    controller.abort();
    release();
    await expect(writing).rejects.toThrow();
    expect(process.write).not.toHaveBeenCalled();
    await expect(
      service.write('operator-a', terminal.id, 'whoami\r', {
        signal: new AbortController().signal,
        expiresAt: Date.now() - 1,
      }),
    ).rejects.toThrow();
    expect(process.write).not.toHaveBeenCalled();
  });
  it('reattaches the same shell after a transport disconnect', async () => {
    const terminal = await service.open('operator-a', {});
    onExit('disconnected');
    expect(service.get('operator-a', terminal.id).state).toBe('running');
    expect((await service.open('operator-a', {})).id).toBe(terminal.id);
    expect(backend.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: terminal.id }),
      true,
      expect.anything(),
    );
  });
  it('preserves an uncertain resume and offers an explicitly new shell only after confirmed absence', async () => {
    const terminal = await service.open('operator-a', {});
    service.detachAll();
    vi.mocked(backend.start).mockRejectedValueOnce(Error('Temporary transport failure'));
    await expect(service.open('operator-a', {})).rejects.toThrow();
    expect(service.get('operator-a', terminal.id).state).toBe('running');
    expect((await service.open('operator-a', {})).id).toBe(terminal.id);
    service.detachAll();
    vi.mocked(backend.start).mockRejectedValueOnce(new TerminalSessionMissing());
    expect(await service.open('operator-a', {})).toMatchObject({ id: terminal.id, state: 'ended' });
    expect((await service.open('operator-a', {})).id).not.toBe(terminal.id);
  });
});
