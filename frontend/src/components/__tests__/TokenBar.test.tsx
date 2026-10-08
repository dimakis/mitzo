// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
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
    tokenLimits:
      (overrides.contextCeiling ?? 200000) > 0
        ? {
            model: 'reported-model',
            source: 'runtime',
            contextWindow: overrides.contextCeiling ?? 200000,
            stale: false,
          }
        : null,
    ...overrides,
  };
}

describe('TokenBar', () => {
  afterEach(cleanup);
  it('renders nothing when no tokens have been tracked', () => {
    const { container } = render(<TokenBar tokenState={makeState()} />);
    expect(container.querySelector('.token-bar')).toBeNull();
  });

  it('keeps the control icon-only and reveals figures only when pressed', () => {
    render(<TokenBar tokenState={makeState({ agentContext: 87204, turnIndex: 1 })} />);
    expect(document.querySelector('.token-bar-label')).toBeNull();
    expect(screen.queryByText('87,204 / 200,000')).toBeNull();
    const button = screen.getByRole('button', { name: 'Token usage' });
    expect(button.title).toBe('Token usage — press for details');
    fireEvent.click(button);
    expect(screen.getByText('87,204 / 200,000')).toBeTruthy();
    expect(screen.getByText(/Context 87k\/200k/).className).toBe('sr-only');
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

  it('retains legacy replayed counts without trusting a ceiling that has no capacity evidence', () => {
    const { container } = render(
      <TokenBar
        tokenState={makeState({ agentContext: 12000, turnIndex: 1, tokenLimits: undefined })}
      />,
    );
    expect(container.querySelector('.token-wheel-fill')).toBeNull();
    expect(container.querySelector('.token-bar--unknown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    expect(screen.getByText('12,000 / limit not reported')).toBeTruthy();
  });

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
      expect(
        screen.getByText(
          overrides.agentContext > 0 ? '12,000 / limit not reported' : 'Not reported',
        ),
      ).toBeTruthy();
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
    // Touch browsers may leave focus elsewhere; Escape must still dismiss.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Agent context')).toBeNull();
  });
});

describe('measured native usage', () => {
  afterEach(cleanup);
  it('shows measured values without depending on a synthetic renderer turn', () => {
    render(
      <TokenBar
        tokenState={makeState({
          agentContext: 12300,
          contextCeiling: 128000,
          sessionTotal: 24600,
          sessionTotalStatus: 'observed',
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Token usage' })).toBeTruthy();
    expect(document.querySelector('.token-bar-label')).toBeNull();
    expect(screen.queryByText('12,300 / 128,000')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    expect(screen.getByText('Session tokens (reported so far)')).toBeTruthy();
    expect(screen.getByText('24,600')).toBeTruthy();
  });
  it('retains a measured context count when the ceiling is unavailable', () => {
    render(
      <TokenBar tokenState={makeState({ agentContext: 12300, contextCeiling: 0, turnIndex: 1 })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    expect(screen.getByText('12,300 / limit not reported')).toBeTruthy();
  });
  it('does not display unknown session usage as a measured zero', () => {
    render(<TokenBar tokenState={makeState({ turnIndex: 1, sessionTotalStatus: 'unknown' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    expect(screen.getAllByText('Not reported')).toHaveLength(2);
  });
});

it('keeps limit provenance in pressed details and does not use stale capacities for occupancy', () => {
  const { container } = render(
    <TokenBar
      tokenState={makeState({
        agentContext: 12000,
        turnIndex: 1,
        contextCeiling: 1000000,
        tokenLimits: {
          model: 'new-model',
          source: 'catalog',
          sourceName: 'Models.dev',
          contextWindow: 1000000,
          outputTokenLimit: 64000,
          checkedAt: 100,
          stale: true,
        },
      })}
    />,
  );
  expect(container.querySelector('.token-wheel-fill')).toBeNull();
  expect(screen.queryByText('Models.dev (stale)')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
  expect(screen.getByText('Models.dev (stale)')).toBeTruthy();
  expect(screen.getByText('64,000')).toBeTruthy();
  expect(screen.getByText('new-model')).toBeTruthy();
  cleanup();
});

it('expires a catalog limit while the chat remains open', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    const { container } = render(
      <TokenBar
        tokenState={makeState({
          agentContext: 1000,
          turnIndex: 1,
          contextCeiling: 64000,
          tokenLimits: {
            model: 'm',
            source: 'catalog',
            sourceName: 'Models.dev',
            contextWindow: 64000,
            checkedAt: 1000,
            expiresAt: 2000,
            stale: false,
          },
        })}
      />,
    );
    expect(container.querySelector('.token-wheel-fill')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1001));
    expect(container.querySelector('.token-wheel-fill')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
    expect(screen.getByText('Models.dev (stale)')).toBeTruthy();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
