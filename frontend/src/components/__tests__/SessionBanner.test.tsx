// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@mitzo/client', () => ({}));

import { SessionBanner } from '../SessionBanner';

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

afterEach(() => cleanup());

const bootContext = {
  source: 'contexgin' as const,
  sourceCount: 5,
  tokenCount: 4200,
  tokenBudget: 8000,
  sources: [{ kind: 'constitution' as const, path: 'CONSTITUTION.md' }],
  included: [
    { source: 'CONSTITUTION.md', heading: 'Identity', tokens: 200, content: 'test content' },
  ],
  trimmed: [],
  fullMarkdown: '# Full boot context markdown',
};

describe('SessionBanner', () => {
  it('returns null when both props are null', () => {
    const { container } = renderWithRouter(
      <SessionBanner bootContext={null} sessionContext={null} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders banner header when bootContext provided', () => {
    renderWithRouter(<SessionBanner bootContext={bootContext} />);
    expect(screen.getByText(/5 sources/)).toBeTruthy();
    expect(screen.getByText(/4\.2k/)).toBeTruthy();
  });

  it('renders session context summary when sessionContext provided', () => {
    renderWithRouter(<SessionBanner sessionContext="Summary: Build the widget" />);
    expect(screen.getByText(/Build the widget/)).toBeTruthy();
  });

  it('expands to show full session context on click', () => {
    renderWithRouter(<SessionBanner sessionContext="Summary: Build the widget\nStatus: active" />);
    // Session context text should not be visible initially (collapsed)
    expect(screen.queryByText('Session Context')).toBeNull();
    // Click the banner header to expand
    fireEvent.click(screen.getByRole('button', { name: /Build the widget/ }));
    expect(screen.getByText('Session Context')).toBeTruthy();
  });

  it('renders both boot and session context together', () => {
    renderWithRouter(
      <SessionBanner bootContext={bootContext} sessionContext="Summary: Test task" />,
    );
    expect(screen.getByText(/5 sources/)).toBeTruthy();
    expect(screen.getByText(/Test task/)).toBeTruthy();
  });

  it('shows boot context details on nested toggle', () => {
    renderWithRouter(<SessionBanner bootContext={bootContext} />);
    // Expand the banner first
    fireEvent.click(screen.getByRole('button', { name: /5 sources/ }));
    // Now toggle boot context details
    fireEvent.click(screen.getByRole('button', { name: /Boot Context/ }));
    expect(screen.getByText('Sources')).toBeTruthy();
    expect(screen.getByText('CONSTITUTION.md')).toBeTruthy();
  });

  it('opens full markdown modal via view-full button', () => {
    renderWithRouter(<SessionBanner bootContext={bootContext} />);
    // Expand the banner
    fireEvent.click(screen.getByRole('button', { name: /5 sources/ }));
    // Click the ⧉ button
    fireEvent.click(screen.getByTitle('View full markdown'));
    expect(screen.getByText('Boot Context (Full Markdown)')).toBeTruthy();
    expect(screen.getByText('# Full boot context markdown')).toBeTruthy();
  });

  it('closes modal on close button click', () => {
    renderWithRouter(<SessionBanner bootContext={bootContext} />);
    fireEvent.click(screen.getByRole('button', { name: /5 sources/ }));
    fireEvent.click(screen.getByTitle('View full markdown'));
    expect(screen.getByText('Boot Context (Full Markdown)')).toBeTruthy();
    // Close the modal
    fireEvent.click(screen.getByText('\u2715'));
    expect(screen.queryByText('Boot Context (Full Markdown)')).toBeNull();
  });

  it('closes modal on Escape key', () => {
    renderWithRouter(<SessionBanner bootContext={bootContext} />);
    fireEvent.click(screen.getByRole('button', { name: /5 sources/ }));
    fireEvent.click(screen.getByTitle('View full markdown'));
    expect(screen.getByText('Boot Context (Full Markdown)')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Boot Context (Full Markdown)')).toBeNull();
  });
});
