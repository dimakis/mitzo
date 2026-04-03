// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('test crash');
  return <div>Child OK</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Hello')).toBeTruthy();
  });

  it('shows error message when child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('test crash')).toBeTruthy();
  });

  it('Try Again button resets and re-renders children', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Toggleable() {
      if (shouldThrow) throw new Error('crash');
      return <div>Recovered</div>;
    }
    const { rerender } = render(
      <ErrorBoundary>
        <Toggleable />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByText('Try Again'));
    rerender(
      <ErrorBoundary>
        <Toggleable />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Recovered')).toBeTruthy();
  });
});
