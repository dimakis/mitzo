// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@mitzo/client', () => ({}));

import { SessionBanner } from '../SessionBanner';

afterEach(() => cleanup());

const bootContext = {
  source: 'contexgin',
  sourceCount: 5,
  tokenCount: 4200,
  tokenBudget: 8000,
  sources: [{ kind: 'constitution', path: 'CONSTITUTION.md' }],
  included: [{ heading: 'Identity', tokens: 200, content: 'test content' }],
  trimmed: [],
  fullMarkdown: '# Full boot context markdown',
};

describe('SessionBanner', () => {
  it('returns null when both props are null', () => {
    const { container } = render(<SessionBanner bootContext={null} sessionContext={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders banner header when bootContext provided', () => {
    render(<SessionBanner bootContext={bootContext} />);
    expect(screen.getByText(/5 sources/)).toBeTruthy();
    expect(screen.getByText(/4\.2k/)).toBeTruthy();
  });

  it('renders session context summary when sessionContext provided', () => {
    render(<SessionBanner sessionContext="Summary: Build the widget" />);
    expect(screen.getByText(/Build the widget/)).toBeTruthy();
  });

  it('expands to show full session context on click', () => {
    render(<SessionBanner sessionContext="Summary: Build the widget\nStatus: active" />);
    // Session context text should not be visible initially (collapsed)
    expect(screen.queryByText('Session Context')).toBeNull();
    // Click the banner header to expand
    fireEvent.click(screen.getByRole('button', { name: /Build the widget/ }));
    expect(screen.getByText('Session Context')).toBeTruthy();
  });

  it('renders both boot and session context together', () => {
    render(<SessionBanner bootContext={bootContext} sessionContext="Summary: Test task" />);
    expect(screen.getByText(/5 sources/)).toBeTruthy();
    expect(screen.getByText(/Test task/)).toBeTruthy();
  });
});
