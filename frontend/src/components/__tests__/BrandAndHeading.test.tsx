// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoBrand } from '../MitzoBrand';
import { WorkspacePageHeading } from '../WorkspacePageHeading';

afterEach(cleanup);

describe('MitzoBrand', () => {
  it('uses the wordmark by default and links home', () => {
    render(
      <MemoryRouter>
        <MitzoBrand />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Mitzo home').getAttribute('href')).toBe('/');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/mitzo-wordmark.png');
  });

  it('uses the icon in compact spaces', () => {
    render(
      <MemoryRouter>
        <MitzoBrand compact />
      </MemoryRouter>,
    );

    expect(document.querySelector('img')?.getAttribute('src')).toBe('/mitzo-icon.png');
  });
});

describe('WorkspacePageHeading', () => {
  it('renders the shared heading hierarchy', () => {
    render(
      <WorkspacePageHeading
        eyebrow="Calendar"
        title="Make room for what matters"
        description="Your agenda."
      />,
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Make room for what matters',
    );
    expect(screen.getByText('Calendar').classList.contains('workspace-eyebrow')).toBe(true);
    expect(screen.getByText('Your agenda.').classList.contains('workspace-muted')).toBe(true);
  });
});
