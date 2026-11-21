// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SubagentCard } from '../SubagentCard';
import { BackgroundTaskStopController } from '../../lib/background-task-stop';

afterEach(cleanup);
const task = {
  messageId: 'child',
  status: 'running' as const,
  backgroundTask: {
    taskId: 'task',
    runId: 'run',
    processGeneration: 'generation',
    description: 'Inspect sources',
  },
  blocks: [
    {
      blockId: 'out',
      blockType: 'text' as const,
      content: '<script>unsafe()</script> latest output',
    },
  ],
};
const execution = {
  sessionId: 'chat',
  processGeneration: 'generation',
  taskId: 'task',
  runId: 'run',
  parentToolId: 'launch',
  subagentMessageId: 'child',
};

it('labels a restart stop only from explicit terminal evidence', () => {
  const view = render(
    <SubagentCard subagent={{ ...task, status: 'unavailable', stopReason: 'process_restart' }} />,
  );
  expect(screen.queryByText('Stopped after restart')).toBeNull();
  view.rerender(
    <SubagentCard subagent={{ ...task, status: 'cancelled', stopReason: 'process_restart' }} />,
  );
  expect(screen.getByText('Stopped after restart')).toBeTruthy();
});

it.each(['running', 'completed', 'failed', 'cancelled', 'unavailable'] as const)(
  'shows %s with retained inert output and honest unavailable authority',
  (status) => {
    const { container } = render(<SubagentCard subagent={{ ...task, status }} sessionId="chat" />);
    fireEvent.click(screen.getByRole('button', { name: /Background task/ }));
    expect(screen.getByText('<script>unsafe()</script> latest output')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    if (status === 'running') {
      expect(
        (screen.getByRole('button', { name: 'Stop task' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(screen.getByText(/Task-only Stop is not available/)).toBeTruthy();
    }
    if (status === 'unavailable')
      expect(screen.getAllByText(/Status unavailable/).length).toBeGreaterThan(0);
  },
);

it('keeps Stop pending across remount and checks a lost receipt without parent Stop', async () => {
  const stop = vi.fn().mockRejectedValue(new Error('offline'));
  const read = vi.fn(async (request) => ({
    ...request,
    revision: 1,
    status: 'requested' as const,
  }));
  const control = new BackgroundTaskStopController(
    execution,
    { stop, read },
    () => 'fixed-id',
    vi.fn(),
  );
  const view = render(<SubagentCard subagent={task} sessionId="chat" taskControl={control} />);
  fireEvent.click(screen.getByRole('button', { name: /Background task/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop task' }));
  await waitFor(() => expect(screen.getByText('Stop outcome unconfirmed')).toBeTruthy());
  view.unmount();
  render(<SubagentCard subagent={task} sessionId="chat" taskControl={control} />);
  fireEvent.click(screen.getByRole('button', { name: /Background task/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Check Stop request' }));
  await waitFor(() =>
    expect(screen.getByText('Stop requested; waiting for task outcome')).toBeTruthy(),
  );
  expect(stop).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ execution, requestId: 'fixed-id' });
  expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
});

it.each([{ sessionId: 'other' }, { runId: 'other' }, { processGeneration: 'replacement' }])(
  'does not enable a foreign execution control: %j',
  (mismatch) => {
    const stop = vi.fn();
    const control = new BackgroundTaskStopController(
      { ...execution, ...mismatch },
      { stop, read: vi.fn() },
    );
    render(<SubagentCard subagent={task} sessionId="chat" taskControl={control} />);
    fireEvent.click(screen.getByRole('button', { name: /Background task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop task' }));
    expect(stop).not.toHaveBeenCalled();
  },
);

it('cannot turn current generation-less producer receipts into Stop authority', () => {
  const control = new BackgroundTaskStopController(execution, { stop: vi.fn(), read: vi.fn() });
  render(
    <SubagentCard
      subagent={{
        ...task,
        backgroundTask: { ...task.backgroundTask, processGeneration: undefined },
      }}
      sessionId="chat"
      taskControl={control}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Background task/ }));
  expect((screen.getByRole('button', { name: 'Stop task' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
