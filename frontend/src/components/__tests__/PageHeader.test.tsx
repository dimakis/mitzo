// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageHeader } from '../PageHeader';

afterEach(cleanup);

// PageHeader uses MitzoLogo which calls useNavigate, so wrap in MemoryRouter
function renderHeader(props: Parameters<typeof PageHeader>[0]) {
  return render(
    <MemoryRouter>
      <PageHeader {...props} />
    </MemoryRouter>,
  );
}

describe('PageHeader', () => {
  it('renders the title', () => {
    renderHeader({ title: 'Tasks' });
    expect(screen.getByText('Tasks')).toBeTruthy();
  });

  it('renders the MitzoLogo with home link', () => {
    const { container } = renderHeader({ title: 'Inbox' });
    const logo = container.querySelector('.mitzo-logo');
    expect(logo).toBeTruthy();
    expect(screen.getByLabelText('Home')).toBeTruthy();
  });

  it('renders a badge when provided', () => {
    renderHeader({ title: 'Inbox', badge: 5 });
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('does not render a badge when count is 0', () => {
    renderHeader({ title: 'Inbox', badge: 0 });
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders children in the right slot', () => {
    render(
      <MemoryRouter>
        <PageHeader title="Tasks">
          <button data-testid="add-btn">+</button>
          <button data-testid="refresh-btn">refresh</button>
        </PageHeader>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('add-btn')).toBeTruthy();
    expect(screen.getByTestId('refresh-btn')).toBeTruthy();
  });

  it('renders custom center content when center prop is provided', () => {
    renderHeader({ title: 'Calendar', center: <div data-testid="date-nav">Apr 2026</div> });
    expect(screen.getByTestId('date-nav')).toBeTruthy();
    // title should not render when center is provided
    expect(screen.queryByText('Calendar')).toBeNull();
  });

  it('uses the page-header CSS class', () => {
    const { container } = renderHeader({ title: 'Test' });
    expect(container.querySelector('.page-header')).toBeTruthy();
  });
});
