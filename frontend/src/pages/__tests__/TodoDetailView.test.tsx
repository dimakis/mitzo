// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodoDetailView } from '../TodoDetailView';
import type { TodoItem } from '../../types/todo';

const mockNavigate = vi.fn();
const mockLocation = vi.fn();
const mockParams = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation(),
    useParams: () => mockParams(),
  };
});

const fullItem: TodoItem = {
  id: 'abc123',
  summary: 'Fix authentication middleware',
  profile: 'centaur',
  urgency: 0.75,
  starred: false,
  status: 'active',
  ageDays: 5,
  parentId: null,
  children: [],
  childCount: 2,
  completedChildCount: 1,
  sources: [
    {
      type: 'github',
      url: 'https://github.com/dimakis/mitzo/issues/42',
      title: 'Auth middleware broken on refresh',
      author: 'octocat',
      snippet: 'The auth middleware fails to validate tokens after page refresh...',
    },
    {
      type: 'jira',
      url: 'https://issues.redhat.com/browse/RHAIENG-1234',
      title: 'Fix auth flow in session handler',
      author: 'jsmith',
      snippet: 'Related Jira ticket for auth fix',
    },
  ],
  contextHints: {
    repos: ['dimakis/mitzo', 'dimakis/contexgin'],
    paths: ['server/auth.ts', 'server/permission-handler.ts'],
    issues: ['dimakis/mitzo#42'],
    docIds: ['1abc-doc-id'],
    people: ['dimakis'],
    jiraKeys: ['RHAIENG-1234'],
    keywords: ['auth', 'jwt'],
    taskHint: 'Fix token validation in auth middleware after page refresh',
  },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockLocation.mockReturnValue({ state: { item: fullItem } });
  mockParams.mockReturnValue({ id: 'abc123' });
});

describe('TodoDetailView', () => {
  it('renders the item summary', () => {
    render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    expect(screen.getByText('Fix authentication middleware')).toBeTruthy();
  });

  it('renders status, urgency, age, and profile', () => {
    const { container } = render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    expect(container.querySelector('.todo-detail-status')?.textContent).toBe('active');
    expect(container.querySelector('.todo-detail-urgency')?.textContent).toBe('medium');
    expect(container.querySelector('.todo-detail-age')?.textContent).toBe('5d');
    expect(container.querySelector('.todo-detail-profile')?.textContent).toBe('centaur');
  });

  it('renders all sources with type badges and titles', () => {
    const { container } = render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    const badges = container.querySelectorAll('.todo-detail-source-badge');
    expect(badges[0]?.textContent).toBe('GH');
    expect(badges[1]?.textContent).toBe('JR');

    const titles = container.querySelectorAll('.todo-detail-source-title');
    expect(titles[0]?.textContent).toBe('Auth middleware broken on refresh');
    expect(titles[1]?.textContent).toBe('Fix auth flow in session handler');
  });

  it('renders source authors and snippets', () => {
    const { container } = render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    const authors = container.querySelectorAll('.todo-detail-source-author');
    expect(authors[0]?.textContent).toBe('octocat');
    expect(authors[1]?.textContent).toBe('jsmith');

    const snippets = container.querySelectorAll('.todo-detail-source-snippet');
    expect(snippets[0]?.textContent).toContain('auth middleware fails to validate');
    expect(snippets[1]?.textContent).toContain('Related Jira ticket');
  });

  it('renders context hints — repos, paths, issues, jira keys, keywords', () => {
    render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    // Repos
    expect(screen.getByText('dimakis/mitzo')).toBeTruthy();
    expect(screen.getByText('dimakis/contexgin')).toBeTruthy();
    // Paths (these are unique button text)
    expect(screen.getByText('server/auth.ts')).toBeTruthy();
    expect(screen.getByText('server/permission-handler.ts')).toBeTruthy();
    // Issues
    expect(screen.getByText('dimakis/mitzo#42')).toBeTruthy();
    // Jira
    expect(screen.getByText('RHAIENG-1234')).toBeTruthy();
    // Keywords
    expect(screen.getByText('auth')).toBeTruthy();
    expect(screen.getByText('jwt')).toBeTruthy();
  });

  it('renders the task hint', () => {
    render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    expect(
      screen.getByText('Fix token validation in auth middleware after page refresh'),
    ).toBeTruthy();
  });

  it('navigates to chat with prompt on "Open in Chat" click', () => {
    const { container } = render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    fireEvent.click(container.querySelector('.todo-detail-chat-btn')!);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const call = mockNavigate.mock.calls[0][0] as string;
    expect(call).toContain('/chat?');
    expect(call).toContain('prompt=');
    expect(call).toContain('extraTools=Bash');
  });

  it('navigates to file viewer with encoded path when a path chip is clicked', () => {
    render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('server/auth.ts'));
    const call = mockNavigate.mock.calls[0][0] as string;
    expect(call).toContain('/files?');
    expect(call).toContain('path=server%2Fauth.ts');
  });

  it('opens source URL externally when source row is tapped', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );
    const firstSource = container.querySelector('.todo-detail-source-row')!;
    fireEvent.click(firstSource);
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/dimakis/mitzo/issues/42',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('renders gracefully with empty context hints', () => {
    const emptyItem: TodoItem = {
      ...fullItem,
      sources: [],
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

    mockLocation.mockReturnValue({ state: { item: emptyItem } });

    const { container } = render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );

    expect(screen.getByText('Fix authentication middleware')).toBeTruthy();
    expect(container.querySelector('.todo-detail-sources')).toBeNull();
    expect(container.querySelector('.todo-detail-context')).toBeNull();
    expect(container.querySelector('.todo-detail-task-hint')).toBeNull();
  });

  it('fetches item by id when location state is missing (refresh/bookmark)', async () => {
    mockLocation.mockReturnValue({ state: null });
    mockParams.mockReturnValue({ id: 'abc123' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: ['centaur'], items: [fullItem] }),
    } as Response);

    render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Fix authentication middleware')).toBeTruthy();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/todos',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fetchSpy.mockRestore();
  });

  it('navigates to /todos when fetch fallback finds no matching item', async () => {
    mockLocation.mockReturnValue({ state: null });
    mockParams.mockReturnValue({ id: 'nonexistent' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ profiles: [], items: [] }),
    } as Response);

    render(
      <MemoryRouter>
        <TodoDetailView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/todos', { replace: true });
    });
    fetchSpy.mockRestore();
  });
});
