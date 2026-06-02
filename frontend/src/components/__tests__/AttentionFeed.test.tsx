// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AttentionItem } from '../../hooks/useAttentionFeed';

// ─── Mocks ────────────────────────────────────────────────────────────────

let mockFeedReturn = {
  items: [] as AttentionItem[],
  tier1Count: 0,
  loading: false,
};

vi.mock('../../hooks/useAttentionFeed', () => ({
  useAttentionFeed: () => mockFeedReturn,
}));

vi.mock('../../lib/haptics', () => ({
  selectionChanged: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { AttentionFeed } from '../AttentionFeed';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeItem(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    source: 'telos',
    tier: 1,
    subPriority: 3,
    title: `Item ${id}`,
    meta: '1d',
    accentColor: '#fbbf24',
    icon: '\u2605',
    navigateTo: `/todos/${id}`,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeItems(count: number): AttentionItem[] {
  return Array.from({ length: count }, (_, i) => makeItem(`item-${i}`));
}

function setFeed(items: AttentionItem[], tier1Count = 0, loading = false) {
  mockFeedReturn = { items, tier1Count, loading };
}

function renderFeed() {
  return render(
    <MemoryRouter>
      <AttentionFeed />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
  setFeed([]);
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('AttentionFeed', () => {
  it('renders empty state when no items', () => {
    setFeed([]);
    renderFeed();
    expect(screen.getByText('Nothing needs your attention right now.')).toBeTruthy();
  });

  it('renders items as cards', () => {
    setFeed([makeItem('a'), makeItem('b')]);
    renderFeed();
    expect(screen.getByText('Item a')).toBeTruthy();
    expect(screen.getByText('Item b')).toBeTruthy();
  });

  it('shows only DEFAULT_VISIBLE_COUNT items initially', () => {
    setFeed(makeItems(8));
    renderFeed();
    const cards = screen.getAllByText(/^Item item-/);
    expect(cards).toHaveLength(5);
  });

  describe('show more / show less toggle', () => {
    it('shows "Show all N" button when items exceed threshold', () => {
      setFeed(makeItems(8));
      renderFeed();
      expect(screen.getByText('Show all 8')).toBeTruthy();
    });

    it('does not show toggle when items are at or below threshold', () => {
      setFeed(makeItems(5));
      renderFeed();
      expect(screen.queryByText(/Show all/)).toBeNull();
    });

    it('expands to show all items on click', () => {
      setFeed(makeItems(8));
      renderFeed();
      fireEvent.click(screen.getByText('Show all 8'));
      const cards = screen.getAllByText(/^Item item-/);
      expect(cards).toHaveLength(8);
      expect(screen.getByText('Show less')).toBeTruthy();
    });

    it('collapses back on second click', () => {
      setFeed(makeItems(8));
      renderFeed();
      fireEvent.click(screen.getByText('Show all 8'));
      fireEvent.click(screen.getByText('Show less'));
      const cards = screen.getAllByText(/^Item item-/);
      expect(cards).toHaveLength(5);
    });
  });

  describe('showAll resets on collapse', () => {
    it('resets expanded state when section is collapsed and reopened', () => {
      setFeed(makeItems(8));
      renderFeed();

      // Expand items
      fireEvent.click(screen.getByText('Show all 8'));
      expect(screen.getAllByText(/^Item item-/)).toHaveLength(8);

      // Collapse section via header
      fireEvent.click(screen.getByText("What's Next"));
      // Cards should be gone
      expect(screen.queryByText('Item item-0')).toBeNull();

      // Re-open — should show truncated (5), not all 8
      fireEvent.click(screen.getByText("What's Next"));
      expect(screen.getAllByText(/^Item item-/)).toHaveLength(5);
      expect(screen.getByText('Show all 8')).toBeTruthy();
    });
  });

  describe('showAll resets when items shrink', () => {
    it('auto-resets showAll when items drop below threshold', () => {
      setFeed(makeItems(8));
      const { rerender } = renderFeed();

      // Expand
      fireEvent.click(screen.getByText('Show all 8'));
      expect(screen.getAllByText(/^Item item-/)).toHaveLength(8);

      // Simulate items shrinking to 3
      setFeed(makeItems(3));
      act(() => {
        rerender(
          <MemoryRouter>
            <AttentionFeed />
          </MemoryRouter>,
        );
      });

      const cards = screen.getAllByText(/^Item item-/);
      expect(cards).toHaveLength(3);
      // No toggle button should be visible
      expect(screen.queryByText(/Show all/)).toBeNull();
      expect(screen.queryByText('Show less')).toBeNull();
    });
  });

  describe('navigation', () => {
    it('navigates to item target on card click', () => {
      setFeed([makeItem('nav-test', { navigateTo: '/todos/nav-test' })]);
      renderFeed();
      fireEvent.click(screen.getByText('Item nav-test'));
      expect(mockNavigate).toHaveBeenCalledWith('/todos/nav-test');
    });
  });

  describe('summary and badge', () => {
    it('shows tier 1 count in badge', () => {
      setFeed([makeItem('u1', { tier: 1 })], 1);
      renderFeed();
      expect(screen.getByText('1')).toBeTruthy();
    });

    it('shows "all clear" when no items', () => {
      setFeed([]);
      renderFeed();
      expect(screen.getByText('all clear')).toBeTruthy();
    });

    it('shows loading state', () => {
      setFeed([], 0, true);
      renderFeed();
      expect(screen.getByText('loading...')).toBeTruthy();
    });
  });
});
