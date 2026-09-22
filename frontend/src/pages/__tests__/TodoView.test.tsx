// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
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
    selector({ setPendingSession: vi.fn() }),
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TodoView', () => {
  it('shows loading state', () => {
    mockUseTodoData.mockReturnValue({
      loading: true,
      items: [],
      profiles: [],
      ack: vi.fn(),
      done: vi.fn(),
      create: vi.fn(),
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter>
        <TodoView />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows empty state when no items', () => {
    mockUseTodoData.mockReturnValue({
      loading: false,
      items: [],
      profiles: ['work'],
      ack: vi.fn(),
      done: vi.fn(),
      create: vi.fn(),
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter>
        <TodoView />
      </MemoryRouter>,
    );

    expect(screen.getByText('No active items')).toBeTruthy();
  });

  it('shows a load error instead of the empty state', () => {
    mockUseTodoData.mockReturnValue({
      loading: false,
      error: 'Unable to load Telos items',
      items: [],
      profiles: [],
      ack: vi.fn(),
      done: vi.fn(),
      star: vi.fn(),
      create: vi.fn(),
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter>
        <TodoView />
      </MemoryRouter>,
    );

    expect(screen.getByText('Unable to load Telos items')).toBeTruthy();
    expect(screen.queryByText('No active items')).toBeNull();
  });

  it('renders items and profile filters', () => {
    mockUseTodoData.mockReturnValue({
      loading: false,
      items: [
        {
          id: 'abc',
          summary: 'Fix bug',
          profile: 'centaur',
          urgency: 0.5,
          status: 'active',
          ageDays: 2,
          parentId: null,
          children: [],
          childCount: 0,
          completedChildCount: 0,
          sources: [
            { type: 'github', url: 'https://example.com', title: 'Fix', author: 'me', snippet: '' },
          ],
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
        },
      ],
      profiles: ['centaur', 'work'],
      ack: vi.fn(),
      done: vi.fn(),
      create: vi.fn(),
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter>
        <TodoView />
      </MemoryRouter>,
    );

    expect(screen.getByText('Fix bug')).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'centaur' })).toBeTruthy();
    expect(screen.getByText('work')).toBeTruthy();
  });

  it('filters by profile when pill clicked', () => {
    mockUseTodoData.mockReturnValue({
      loading: false,
      items: [],
      profiles: ['centaur', 'work'],
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

    const pills = container.querySelectorAll('.todo-filter-pill');
    // All, centaur, work
    expect(pills.length).toBe(3);
    fireEvent.click(pills[1]); // centaur
    expect(mockUseTodoData).toHaveBeenLastCalledWith('centaur');
  });

  it('navigates to detail view on item tap', () => {
    const item = {
      id: 'abc',
      summary: 'Fix bug',
      profile: 'centaur',
      urgency: 0.5,
      status: 'active',
      ageDays: 2,
      parentId: null,
      children: [],
      childCount: 0,
      completedChildCount: 0,
      sources: [
        { type: 'github', url: 'https://example.com', title: 'Fix', author: 'me', snippet: '' },
      ],
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
    };

    mockUseTodoData.mockReturnValue({
      loading: false,
      items: [item],
      profiles: ['centaur'],
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

    // Simulate tap on the todo card
    const card = container.querySelector('.todo-card')!;
    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(card);

    expect(mockNavigate).toHaveBeenCalledWith('/todos/abc', {
      state: { item, activeProfile: undefined, scrollTop: 0 },
    });
  });

  it('renders MitzoLogo for home navigation', () => {
    mockUseTodoData.mockReturnValue({
      loading: false,
      items: [],
      profiles: [],
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

    expect(container.querySelector('.mitzo-logo')).toBeTruthy();
  });

  it('searches outcome text and context', () => {
    const makeItem = (id: string, summary: string, intent: string, path: string) => ({
      id,
      summary,
      intent,
      profile: 'work',
      urgency: 0.5,
      starred: false,
      status: 'active' as const,
      ageDays: 1,
      parentId: null,
      children: [],
      childCount: 0,
      completedChildCount: 0,
      sources: [],
      contextHints: {
        repos: [],
        paths: [path],
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
      items: [
        makeItem('one', 'Authentication', 'Sessions survive refresh', 'server/auth.ts'),
        makeItem('two', 'Billing', 'Invoices reconcile', 'server/billing.ts'),
      ],
      profiles: ['work'],
      ack: vi.fn(),
      done: vi.fn(),
      star: vi.fn(),
      create: vi.fn(),
      refresh: vi.fn(),
    });
    render(
      <MemoryRouter>
        <TodoView />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Telos items' }), {
      target: { value: 'auth.ts' },
    });

    expect(screen.getByText('Authentication')).toBeTruthy();
    expect(screen.queryByText('Billing')).toBeNull();
  });
});
