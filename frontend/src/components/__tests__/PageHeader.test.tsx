// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PageHeader } from '../PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="Tasks" />);
    expect(screen.getByText('Tasks')).toBeTruthy();
  });

  it('renders a back button when onBack is provided', () => {
    const onBack = vi.fn();
    render(<PageHeader title="Inbox" onBack={onBack} />);
    const btn = screen.getByTitle('Back');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('does not render a back button when onBack is omitted', () => {
    render(<PageHeader title="Home" />);
    expect(screen.queryByTitle('Back')).toBeNull();
  });

  it('renders a badge when provided', () => {
    render(<PageHeader title="Inbox" badge={5} />);
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('does not render a badge when count is 0', () => {
    render(<PageHeader title="Inbox" badge={0} />);
    // badge should not render for 0
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders children in the right slot', () => {
    render(
      <PageHeader title="Tasks">
        <button data-testid="add-btn">+</button>
        <button data-testid="refresh-btn">refresh</button>
      </PageHeader>,
    );
    expect(screen.getByTestId('add-btn')).toBeTruthy();
    expect(screen.getByTestId('refresh-btn')).toBeTruthy();
  });

  it('renders custom center content when center prop is provided', () => {
    render(<PageHeader title="Calendar" center={<div data-testid="date-nav">Apr 2026</div>} />);
    expect(screen.getByTestId('date-nav')).toBeTruthy();
    // title should not render when center is provided
    expect(screen.queryByText('Calendar')).toBeNull();
  });

  it('uses the page-header CSS class', () => {
    const { container } = render(<PageHeader title="Test" />);
    expect(container.querySelector('.page-header')).toBeTruthy();
  });

  it('uses lsaquo character for back button', () => {
    render(<PageHeader title="Test" onBack={() => {}} />);
    const btn = screen.getByTitle('Back');
    expect(btn.textContent).toBe('\u2039');
  });
});
