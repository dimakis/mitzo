import { afterEach, expect, it, vi } from 'vitest';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { admitConfiguredTools } from '../configured-tool-admission.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const catalog = new ConfiguredToolCatalog(':memory:');
  cleanup.push(() => catalog.close());
  const abort = new AbortController();
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'result' }] }));
  const close = vi.fn(async () => {});
  const peer = {
    listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
    callTool: call,
    close,
  };
  const connect = vi.fn(async () => peer);
  const sources = {
    docs: { command: 'docs', librarySourceId: '11111111-1111-4111-8111-111111111111' },
    issues: { command: 'issues', librarySourceId: '22222222-2222-4222-8222-222222222222' },
  };
  const options = {
    cwd: '/fixture',
    env: {},
    signal: abort.signal,
    readSources: () => sources,
    assertRuntimeCurrent: vi.fn(),
    connect,
  };
  const refs = (await catalog.refresh(options)).map((entry) => catalog.reference(entry));
  connect.mockClear();
  close.mockClear();
  const tools = await admitConfiguredTools(catalog, refs, options);
  cleanup.push(() => tools.close());
  const execute = (index = 0, signal = abort.signal) =>
    tools.execute(
      tools.definitions[index].name,
      {},
      async () => ({ behavior: 'allow' as const }),
      signal,
    );
  return { tools, connect, call, close, peer, abort, execute, sources };
}

it('exposes pinned definitions without launching sources; first use connects only its source once', async () => {
  const f = await fixture();
  expect(f.connect).not.toHaveBeenCalled();
  const scope = f.tools.outputScope(f.tools.definitions[0].name);
  await Promise.all([f.execute(), f.execute()]);
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(f.tools.outputScope(f.tools.definitions[0].name)).toBe(scope);
  await f.execute(1);
  expect(f.connect).toHaveBeenCalledTimes(2);
});
it('closing unused tools does not launch a source', async () => {
  const f = await fixture();
  await f.tools.close();
  expect(f.connect).not.toHaveBeenCalled();
  await expect(f.execute()).rejects.toThrow();
});
it('retained-output reads verify the live descriptor before accepting its original scope', async () => {
  const f = await fixture();
  const name = f.tools.definitions[0].name;
  f.peer.listTools = async () => ({
    tools: [{ name: 'changed', inputSchema: { type: 'object' } }],
  });
  await expect(f.tools.ensureToolCurrent(name, f.abort.signal)).rejects.toThrow(
    /definition changed/,
  );
  expect(f.call).not.toHaveBeenCalled();
});
it('refuses revoked sources and already cancelled calls before connecting', async () => {
  const f = await fixture();
  const call = new AbortController();
  call.abort();
  await expect(f.execute(0, call.signal)).rejects.toThrow();
  f.sources.docs.command = 'changed';
  await expect(f.execute()).rejects.toThrow();
  expect(f.connect).not.toHaveBeenCalled();
});
it('cancels a lone initialization and closes a late peer without executing or retrying', async () => {
  const f = await fixture();
  let release!: () => void;
  f.connect.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.peer;
  });
  const call = new AbortController();
  const pending = f.execute(0, call.signal);
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
  call.abort();
  await expect(pending).rejects.toThrow();
  release();
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  await expect(f.execute()).rejects.toThrow();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.call).not.toHaveBeenCalled();
});
it('one cancelled waiter does not cancel another call sharing initialization', async () => {
  const f = await fixture();
  let release!: () => void;
  f.connect.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.peer;
  });
  const call = new AbortController();
  const first = f.execute(0, call.signal);
  const second = f.execute();
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
  call.abort();
  await expect(first).rejects.toThrow();
  release();
  await second;
  expect(f.call).toHaveBeenCalledOnce();
});

it.each(['close', 'session_abort'] as const)(
  'retires initialization on %s and closes late arrivals',
  async (mode) => {
    const f = await fixture();
    let release!: () => void;
    f.connect.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return f.peer;
    });
    const pending = f.execute();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    if (mode === 'session_abort') f.abort.abort();
    await f.tools.close();
    await rejected;
    release();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.call).not.toHaveBeenCalled();
  },
);
