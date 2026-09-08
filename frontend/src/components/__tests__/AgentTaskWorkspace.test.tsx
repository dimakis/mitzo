// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentTaskWorkspace } from '../AgentTaskWorkspace';
import type { Task } from '../../types/task';

function task(id: string, status: Task['status'], extra: Partial<Task> = {}): Task {
  return {
    id,
    status,
    title: id,
    parentId: null,
    description: null,
    sessionId: null,
    sessionPolicy: 'reuse',
    priority: 0,
    depth: 0,
    annotations: [],
    summary: null,
    requiresApproval: false,
    tokenUsage: 0,
    claimedBy: null,
    claimedAt: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    stageType: null,
    gateConfig: null,
    artifacts: null,
    retryCount: 0,
    maxRetries: 0,
    templateId: null,
    children: [],
    ...extra,
  };
}
const child = task('Review result', 'pending_review', {
  parentId: 'Build page',
  tokenUsage: 25,
  description: 'Check keyboard navigation',
  sessionId: 'session-123',
  annotations: ['Requires human review'],
});
const parent = task('Build page', 'active', { children: [child], tokenUsage: 100 });
afterEach(cleanup);
function mount(tasks: Task[], selectedId: string | null = null, onSelect = vi.fn()) {
  return render(
    <MemoryRouter>
      <AgentTaskWorkspace
        tasks={tasks}
        selectedId={selectedId}
        onSelect={onSelect}
        renderTask={(t) => <button>Existing controls: {t.title}</button>}
      />
    </MemoryRouter>,
  );
}
describe('desktop agent task workspace', () => {
  it('surfaces nested review work in its actual state lane without duplication', () => {
    const select = vi.fn();
    mount([parent], null, select);
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    fireEvent.click(within(attention).getByRole('button', { name: /Review result/ }));
    expect(select).toHaveBeenCalledWith('Review result');
    expect(screen.getAllByRole('button', { name: /Review result/ })).toHaveLength(1);
    expect(within(attention).getByText('Within Build page')).toBeTruthy();
  });
  it('retains every task state including completed and skipped work', () => {
    mount(
      ['pending', 'active', 'done', 'pending_review', 'blocked', 'skipped', 'failed'].map((s) =>
        task(s, s as Task['status']),
      ),
    );
    for (const s of [
      'pending',
      'active',
      'done',
      'pending_review',
      'blocked',
      'skipped',
      'failed',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${s} `) })).toBeTruthy();
    }
  });
  it('shows actual context and scoped tokens alongside existing task controls', () => {
    mount([parent], child.id);
    const detail = screen.getByRole('region', { name: 'Execution details' });
    expect(within(detail).getByText('Check keyboard navigation')).toBeTruthy();
    expect(within(detail).getByText('Requires human review')).toBeTruthy();
    expect(within(detail).getByText('25')).toBeTruthy();
    expect(within(detail).getByText('Recorded tokens for this task')).toBeTruthy();
    expect(within(detail).getByRole('link', { name: 'Open session' }).getAttribute('href')).toBe(
      '/chat/session-123',
    );
    expect(
      within(detail).getByRole('button', { name: 'Existing controls: Review result' }),
    ).toBeTruthy();
  });
  it('does not add descendant spend to the selected task counter', () => {
    mount([parent], parent.id);
    const detail = screen.getByRole('region', { name: 'Execution details' });
    expect(within(detail).getByText('100')).toBeTruthy();
    expect(within(detail).queryByText('125')).toBeNull();
  });
  it('shows an honest missing selection state after a task is removed', () => {
    mount([], 'deleted');
    expect(screen.getByText('This task is no longer in the current board.')).toBeTruthy();
  });
});
