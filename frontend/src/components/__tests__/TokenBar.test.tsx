// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TokenBar } from '../TokenBar';
import type { TokensState as TokenState } from '@mitzo/client';

function makeState(overrides: Partial<TokenState> = {}): TokenState {
  return {
    agentContext: 0,
    contextCeiling: 200_000,
    sessionTotal: 0,
    numTurns: 0,
    turnIndex: 0,
    numCompactions: 0,
    ...overrides,
  };
}

describe('TokenBar', () => {
  afterEach(cleanup);
  it('renders nothing when no tokens have been tracked', () => {
    const { container } = render(<TokenBar tokenState={makeState()} />);
    expect(container.querySelector('.token-bar')).toBeNull();
  });

  it('describes context occupancy without a visible text badge', () => {
    render(<TokenBar tokenState={makeState({ agentContext: 87204, turnIndex: 1 })} />);
    // Should show formatted token count
    expect(screen.getByText(/87k/).className).toBe('sr-only');
    expect(document.querySelector('.token-wheel')).toBeTruthy();
  });

  it('renders session total with sigma icon when available', () => {
    render(
      <TokenBar
        tokenState={makeState({
          agentContext: 87204,
          sessionTotal: 142580,
          turnIndex: 1,
        })}
      />,
    );
    expect(screen.getByText(/143k/).className).toBe('sr-only');
  });

  it('applies green color class for low context usage', () => {
    const { container } = render(
      <TokenBar tokenState={makeState({ agentContext: 50000, turnIndex: 1 })} />,
    );
    expect(container.querySelector('.token-bar--green')).toBeTruthy();
  });

  it('applies yellow color class for medium context usage', () => {
    const { container } = render(
      <TokenBar tokenState={makeState({ agentContext: 120000, turnIndex: 1 })} />,
    );
    expect(container.querySelector('.token-bar--yellow')).toBeTruthy();
  });

  it('applies red color class for high context usage', () => {
    const { container } = render(
      <TokenBar tokenState={makeState({ agentContext: 170000, turnIndex: 1 })} />,
    );
    expect(container.querySelector('.token-bar--red')).toBeTruthy();
  });

  it('applies flashing class near ceiling', () => {
    const { container } = render(
      <TokenBar tokenState={makeState({ agentContext: 195000, turnIndex: 1 })} />,
    );
    expect(container.querySelector('.token-bar--flashing')).toBeTruthy();
  });

  it('renders session total for completed sessions (agentContext=0)', () => {
    const { container } = render(
      <TokenBar
        tokenState={makeState({
          agentContext: 0,
          sessionTotal: 50000,
          numTurns: 5,
          turnIndex: 5,
        })}
      />,
    );
    // Should render (not return null)
    expect(container.querySelector('.token-bar')).toBeTruthy();
    // Should show session total
    expect(screen.getByText(/50k/).className).toBe('sr-only');
    // Should NOT show agent context bar (0/200k is meaningless for completed sessions)
    expect(screen.queryByText(/0\/200k/)).toBeNull();
  });

  it('does not crash when sessionTotal is undefined (mid-turn state)', () => {
    const state = makeState({
      agentContext: 87204,
      turnIndex: 1,
    });
    // Simulate the bug: sessionTotal clobbered to undefined by partial spread
    (state as unknown as Record<string, unknown>).sessionTotal = undefined;
    const { container } = render(<TokenBar tokenState={state} />);
    const bar = container.querySelector('.token-bar')!;
    fireEvent.click(bar);
    // Should render detail panel without crashing
    expect(screen.getByText(/Agent context/)).toBeTruthy();
    expect(screen.getByText(/Session tokens/)).toBeTruthy();
  });

  it('expands detail panel on tap', () => {
    render(
      <TokenBar
        tokenState={makeState({
          agentContext: 87204,
          sessionTotal: 142580,
          numTurns: 5,
          turnIndex: 3,
        })}
      />,
    );

    const bar = screen.getByRole('button', { name: /token/i });
    fireEvent.click(bar);

    expect(screen.getByText(/5 turns/)).toBeTruthy();
    expect(screen.getByText(/142,580/)).toBeTruthy();
  });
});

describe('context wheel', () => {
  afterEach(cleanup);

  it.each([
    [50000, 75],
    [100000, 50],
    [200000, 0],
    [250000, 0],
  ])('fills clockwise for %s tokens and clamps at capacity', (agentContext, offset) => {
    const { container } = render(
      <TokenBar tokenState={makeState({ agentContext, turnIndex: 1 })} />,
    );
    const fill = container.querySelector('.token-wheel-fill');
    expect(fill?.getAttribute('stroke-dashoffset')).toBe(String(offset));
    expect(fill?.getAttribute('transform')).toBe('rotate(-90 12 12)');
  });

  it.each([{ agentContext: 0 }, { agentContext: 12000, contextCeiling: 0 }])(
    'shows unavailable occupancy as unknown rather than an empty green budget: %j',
    (overrides) => {
      const { container } = render(
        <TokenBar tokenState={makeState({ ...overrides, turnIndex: 1 })} />,
      );
      expect(container.querySelector('.token-bar--unknown')).toBeTruthy();
      expect(container.querySelector('.token-wheel-fill')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
      expect(screen.getByText('Not reported')).toBeTruthy();
      expect(screen.queryByText('0 / 200,000')).toBeNull();
    },
  );

  it('keeps spend separate from occupancy and toggles the detail popover', () => {
    render(
      <TokenBar
        tokenState={makeState({ agentContext: 12000, sessionTotal: 24000, turnIndex: 1 })}
      />,
    );
    const button = screen.getByRole('button', { name: 'Token usage' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByText('12,000 / 200,000')).toBeTruthy();
    expect(screen.getByText('24,000')).toBeTruthy();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Agent context')).toBeNull();
  });
});
