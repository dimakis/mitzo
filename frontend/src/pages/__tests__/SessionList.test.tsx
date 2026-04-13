// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SessionList } from '../SessionList';

function mockFetchResponses(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    '/api/sessions': [],
    '/api/config': { quickActions: [] },
    '/api/inbox': [],
    '/api/version': {},
    '/api/todos': { items: [] },
    ...overrides,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = defaults[url] ?? {};
      return Promise.resolve({ json: () => Promise.resolve(body) });
    }),
  );
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  document.body.removeChild(container);
  vi.restoreAllMocks();
});

function renderSessionList() {
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(SessionList)));
  });
  return root;
}

describe('SessionList status dot', () => {
  it('renders green dot for active+attached session', async () => {
    mockFetchResponses({
      '/api/sessions': [
        { id: 's1', summary: 'Test', lastModified: 1, isActive: true, isAttached: true },
      ],
    });

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const dot = container.querySelector('.session-status-dot');
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains('attached')).toBe(true);
    expect(dot!.getAttribute('aria-label')).toBe('Session active');
  });

  it('renders orange dot for active+detached session', async () => {
    mockFetchResponses({
      '/api/sessions': [
        { id: 's1', summary: 'Test', lastModified: 1, isActive: true, isAttached: false },
      ],
    });

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const dot = container.querySelector('.session-status-dot');
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains('detached')).toBe(true);
    expect(dot!.getAttribute('aria-label')).toBe('Session detached');
  });

  it('does not render dot for inactive session', async () => {
    mockFetchResponses({
      '/api/sessions': [
        { id: 's1', summary: 'Test', lastModified: 1, isActive: false, isAttached: false },
      ],
    });

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const dot = container.querySelector('.session-status-dot');
    expect(dot).toBeNull();
  });
});

describe('SessionList', () => {
  it('does not render inline inbox/todo nav buttons (tab bar handles navigation)', async () => {
    mockFetchResponses({
      '/api/inbox': [{ id: '1' }, { id: '2' }],
    });

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Old inbox-nav-btn should be gone — tab bar handles navigation now
    const inboxBtn = container.querySelector('.inbox-nav-btn');
    expect(inboxBtn).toBeNull();
  });

  it('renders update banner when version endpoint reports update', async () => {
    mockFetchResponses({
      '/api/version': { updateAvailable: true },
    });

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const banner = container.querySelector('.update-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toMatch(/Update available/);
  });

  it('renders the hero New Chat button', async () => {
    mockFetchResponses();

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const heroBtn = container.querySelector('.hero-chat-btn');
    expect(heroBtn).not.toBeNull();
  });
});
