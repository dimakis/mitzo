// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { createRef } from 'react';
const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  write: vi.fn(),
  reset: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    buffer = {
      active: { length: 1, getLine: () => ({ translateToString: () => 'selected output' }) },
    };
    open() {}
    loadAddon() {}
    dispose = mocks.dispose;
    write = mocks.write;
    reset = mocks.reset;
    onData = mocks.onData;
    getSelection() {
      return '';
    }
    focus() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'test-auth-lost' }));
import { apiFetch } from '../../lib/api-fetch';
import { TerminalConsole, type TerminalConsoleHandle } from '../TerminalConsole';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('reattaches output, keeps writes deliberate and detaches without ending the shell', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/events')
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"snapshot","data":"prompt","seq":1}\n\n'),
              );
            },
          }),
        )
      : new Response('{}'),
  );
  const ref = createRef<TerminalConsoleHandle>(),
    onStatus = vi.fn();
  const view = render(
    <TerminalConsole ref={ref} terminalId="owned" onStatus={onStatus} onError={vi.fn()} />,
  );
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('prompt'));
  expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/input'), expect.anything());
  await ref.current!.send('pwd\r');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/terminals/owned/input',
    expect.objectContaining({ body: JSON.stringify({ data: 'pwd\r' }) }),
  );
  expect(ref.current!.reviewOutput()).toBe('selected output');
  view.unmount();
  expect(mocks.dispose).toHaveBeenCalled();
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).endsWith('/end'))).toBe(
    false,
  );
});
