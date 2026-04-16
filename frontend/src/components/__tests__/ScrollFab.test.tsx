// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ScrollFab } from '../ScrollFab';

afterEach(() => cleanup());

function makeScrollEl(overrides: Partial<HTMLDivElement> = {}): HTMLDivElement {
  return {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 600,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
    ...overrides,
  } as unknown as HTMLDivElement;
}

describe('ScrollFab', () => {
  it('renders nothing when scrollRef is null', () => {
    const ref = { current: null };
    const { container } = render(<ScrollFab scrollRef={ref} />);
    expect(container.querySelector('.scroll-fab')).toBeNull();
  });

  it('shows scroll-to-bottom button when far from bottom', () => {
    const el = makeScrollEl({ scrollTop: 0 });
    const ref = { current: el };
    render(<ScrollFab scrollRef={ref} />);

    // Trigger the scroll event handler
    const scrollHandler = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'scroll',
    )?.[1];
    expect(scrollHandler).toBeTruthy();

    act(() => scrollHandler!());

    const downBtn = screen.queryByLabelText('Scroll to bottom');
    expect(downBtn).toBeTruthy();
  });

  it('shows scroll-to-top button when far from top', () => {
    const el = makeScrollEl({ scrollTop: 1400 }); // near bottom
    const ref = { current: el };
    render(<ScrollFab scrollRef={ref} />);

    const scrollHandler = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'scroll',
    )?.[1];

    act(() => scrollHandler!());

    const upBtn = screen.queryByLabelText('Scroll to top');
    expect(upBtn).toBeTruthy();
  });

  it('calls scrollTo when buttons are clicked', () => {
    const el = makeScrollEl({ scrollTop: 500 }); // middle
    const ref = { current: el };
    render(<ScrollFab scrollRef={ref} />);

    const scrollHandler = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'scroll',
    )?.[1];

    act(() => scrollHandler!());

    const downBtn = screen.getByLabelText('Scroll to bottom');
    fireEvent.click(downBtn);
    expect(el.scrollTo).toHaveBeenCalledWith({ top: el.scrollHeight, behavior: 'smooth' });

    const upBtn = screen.getByLabelText('Scroll to top');
    fireEvent.click(upBtn);
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('hides both buttons when content fits without scrolling', () => {
    const el = makeScrollEl({ scrollTop: 0, scrollHeight: 500, clientHeight: 600 });
    const ref = { current: el };
    render(<ScrollFab scrollRef={ref} />);

    const scrollHandler = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'scroll',
    )?.[1];

    act(() => scrollHandler!());

    expect(screen.queryByLabelText('Scroll to top')).toBeNull();
    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });
});
