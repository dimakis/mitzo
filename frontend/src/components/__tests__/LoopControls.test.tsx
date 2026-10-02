// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LoopControls } from '../LoopControls';
import type { LoopStatus, Task } from '../../types/task';

afterEach(cleanup);

describe('LoopControls', () => {
  it('allows a spawn-only goal to pause without a chat while requiring a chat for reuse', () => {
    const spawnGoal = {
      id: 'spawn-goal',
      title: 'Spawn later',
      stageType: 'agent_work',
      sessionPolicy: 'spawn',
      children: [],
    } as unknown as Task;
    const reuseGoal = {
      id: 'reuse-goal',
      title: 'Use a chat',
      stageType: 'agent_work',
      sessionPolicy: 'auto',
      children: [],
    } as unknown as Task;
    const loopStatus: LoopStatus = {
      state: 'idle',
      goalId: null,
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
      spawnEnabled: false,
    };
    const onStart = vi.fn();
    render(
      <LoopControls
        loopStatus={loopStatus}
        goals={[spawnGoal, reuseGoal]}
        totalTokenUsage={0}
        currentSessionId="chat-1"
        onStart={onStart}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onApproveSpec={vi.fn()}
        onRejectSpec={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Start a workflow/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'spawn-goal' } });
    const start = screen.getByRole('button', { name: 'Start' });
    expect((start as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'reuse-goal' } });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use this chat for tasks' }));
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith('reuse-goal', undefined, 'chat-1');
  });
});
