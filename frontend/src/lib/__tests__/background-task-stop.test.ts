import { afterEach, expect, it, vi } from 'vitest';
import {
  BackgroundTaskStopController,
  type TaskStopAdapter,
  type TaskStopRequest,
} from '../background-task-stop';

const execution = {
  sessionId: 'chat',
  processGeneration: 'generation',
  taskId: 'task',
  runId: 'run',
  parentToolId: 'launch',
  subagentMessageId: 'child',
};
afterEach(() => vi.useRealTimers());

it('bounds a stalled response and keeps the original request available for inspection', async () => {
  vi.useFakeTimers();
  const { adapter, control } = setup();
  vi.mocked(adapter.stop).mockReturnValue(new Promise(() => {}));
  const pending = control.request();
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(control.getSnapshot().status).toBe('unknown');
  await control.request();
  expect(adapter.stop).toHaveBeenCalledTimes(1);
});
function setup() {
  const adapter: TaskStopAdapter = { stop: vi.fn(), read: vi.fn() };
  const diagnostic = vi.fn();
  return {
    adapter,
    diagnostic,
    control: new BackgroundTaskStopController(execution, adapter, () => 'request-1', diagnostic),
  };
}
const receipt = (
  request: TaskStopRequest,
  status: 'requested' | 'refused' | 'unknown',
  revision = 1,
) => ({ ...request, revision, status });

it('coalesces double clicks and keeps accepted Stop separate from task termination', async () => {
  const { adapter, control } = setup();
  let resolve!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(adapter.stop).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = control.request();
  await control.request();
  expect(adapter.stop).toHaveBeenCalledTimes(1);
  expect(control.getSnapshot().status).toBe('pending');
  const request = vi.mocked(adapter.stop).mock.calls[0][0];
  expect(request).toEqual({ execution, requestId: 'request-1' });
  resolve(receipt(request, 'requested'));
  await pending;
  expect(control.getSnapshot().status).toBe('requested');
  await control.request();
  expect(adapter.stop).toHaveBeenCalledTimes(1);
});

it('recovers a lost response by reading the exact frozen request, never resubmitting', async () => {
  const { adapter, diagnostic, control } = setup();
  vi.mocked(adapter.stop).mockRejectedValue(new Error('private backend detail'));
  await control.request();
  expect(control.getSnapshot().status).toBe('unknown');
  expect(diagnostic).toHaveBeenCalledWith('stop_request_failed', 'request-1');
  vi.mocked(adapter.read).mockImplementation(async (request) => receipt(request, 'requested', 2));
  await control.check();
  expect(adapter.read).toHaveBeenCalledWith(vi.mocked(adapter.stop).mock.calls[0][0]);
  expect(control.getSnapshot().status).toBe('requested');
  expect(adapter.stop).toHaveBeenCalledTimes(1);
});

it('refuses foreign generation/receipt identity and preserves newer receipt evidence', async () => {
  const { adapter, control } = setup();
  vi.mocked(adapter.stop).mockImplementation(async (request) => ({
    ...receipt(request, 'requested'),
    execution: { ...execution, processGeneration: 'replacement' },
  }));
  await control.request();
  expect(control.getSnapshot().status).toBe('unknown');
  vi.mocked(adapter.read).mockImplementation(async (request) => receipt(request, 'requested', 4));
  await control.check();
  vi.mocked(adapter.read).mockImplementation(async (request) => receipt(request, 'refused', 3));
  await control.check();
  expect(control.getSnapshot().status).toBe('requested');
});

it('retains explicit refusal and read failure without retrying a mutation', async () => {
  const { adapter, control } = setup();
  vi.mocked(adapter.stop).mockImplementation(async (request) => receipt(request, 'refused'));
  await control.request();
  expect(control.getSnapshot().status).toBe('refused');
  vi.mocked(adapter.read).mockRejectedValue(new Error('offline'));
  await control.check();
  expect(control.getSnapshot()).toMatchObject({ status: 'refused', checkFailed: true });
  await control.request();
  expect(adapter.stop).toHaveBeenCalledTimes(1);
});
