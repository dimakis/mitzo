// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodoCard } from '../TodoCard';
import { TelosSection } from '../TelosSection';
import type { TodoItem } from '../../types/todo';

const data = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({
    ...data,
    loading: false,
    error: null,
    profiles: [],
    ack: vi.fn(),
    done: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('../CollapsibleSection', () => ({
  CollapsibleSection: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
afterEach(cleanup);

it('uses the same compact header on the TELOS cards and preserves the full item for actions', () => {
  const item = {
    id: 'one',
    summary: '# Canonical recovery\n\nA very long saved handover body.',
    status: 'active',
    starred: false,
    ageDays: 0,
    urgency: 0,
    sources: [],
    children: [],
  } as unknown as TodoItem;
  data.items = [item];
  render(
    <MemoryRouter>
      <TodoCard
        item={item}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
        onStar={vi.fn()}
        onStartSession={vi.fn()}
      />
      <TelosSection />
    </MemoryRouter>,
  );
  expect(screen.getAllByText('Canonical recovery')).toHaveLength(2);
  expect(screen.queryByText(/long saved handover/)).toBeNull();
  expect(item.summary).toContain('long saved handover');
});
