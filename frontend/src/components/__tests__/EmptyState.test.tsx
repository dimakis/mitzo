// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EmptyState } from '../EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('renders icon, title, and subtitle', () => {
    render(<EmptyState icon="!" title="All done" subtitle="Nothing left" />);
    expect(screen.getByText('!')).toBeTruthy();
    expect(screen.getByText('All done')).toBeTruthy();
    expect(screen.getByText('Nothing left')).toBeTruthy();
  });

  it('renders without subtitle', () => {
    render(<EmptyState icon="\u2610" title="No tasks yet" />);
    expect(screen.getByText('No tasks yet')).toBeTruthy();
  });

  it('uses the empty-state CSS class', () => {
    const { container } = render(<EmptyState icon="!" title="Empty" />);
    expect(container.querySelector('.empty-state')).toBeTruthy();
  });
});
