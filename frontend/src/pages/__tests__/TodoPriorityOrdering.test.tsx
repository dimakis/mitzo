// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodoView } from '../TodoView';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockUseTodoData = vi.fn();
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: (...args: unknown[]) => mockUseTodoData(...args),
}));

vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('preserves the approved grouping and urgency order when numeric priorities differ', () => {
  const makeItem = (id: string, priority: number, starred: boolean, urgency: number) => ({
    id,
    summary: id,
    priority,
    starred,
    urgency,
    profile: 'work',
    status: 'active',
    ageDays: 0,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [],
    goalId: null,
    contextHints: {
      repos: [],
      paths: [],
      issues: [],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: '',
    },
  });
  mockUseTodoData.mockReturnValue({
    loading: false,
    error: null,
    profiles: ['work'],
    items: [
      makeItem('Existing focus', 2, true, 0.9),
      makeItem('Higher urgency', 1, false, 0.8),
      makeItem('Higher number', 10, false, 0.2),
    ],
    ack: vi.fn(),
    done: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
  });
  const { container } = render(
    <MemoryRouter>
      <TodoView />
    </MemoryRouter>,
  );
  const sections = [...container.querySelectorAll('.todo-section')];
  expect(sections[0].textContent).toContain('Focus');
  expect(sections[0].textContent).toContain('Existing focus');
  expect(sections[0].textContent).not.toContain('Higher number');
  const active = sections.find((section) => section.textContent?.includes('Higher urgency'))!;
  expect(
    [...active.querySelectorAll('.todo-card-summary')].map((node) => node.textContent),
  ).toEqual(['Higher urgency', 'Higher number']);
});
