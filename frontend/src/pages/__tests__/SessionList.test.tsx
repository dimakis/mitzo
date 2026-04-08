// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
// React 19 doesn't export act from 'react' in CJS; use react-dom/test-utils
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { SessionList } from '../SessionList';

function mockFetchResponses(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    '/api/sessions': [],
    '/api/config': { quickActions: [] },
    '/api/inbox': [],
    '/api/version': {},
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

describe('SessionList inbox badge', () => {
  it('renders badge with correct count when inbox has items', async () => {
    mockFetchResponses({
      '/api/inbox': [{ id: '1' }, { id: '2' }, { id: '3' }],
    });

    renderSessionList();

    // Wait for async fetch + state update
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const badge = container.querySelector('.inbox-nav-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('3');
  });

  it('does not render badge when inbox is empty', async () => {
    mockFetchResponses({ '/api/inbox': [] });

    renderSessionList();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const badge = container.querySelector('.inbox-nav-badge');
    expect(badge).toBeNull();
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
});
