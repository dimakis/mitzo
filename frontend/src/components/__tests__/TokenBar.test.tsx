// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TokenBar } from '../TokenBar';
import type { TokenState } from '../../hooks/useTokenState';

function makeState(overrides: Partial<TokenState> = {}): TokenState {
  return {
    agentContext: 0,
    contextCeiling: 200_000,
    sessionTotal: 0,
    numTurns: 0,
    turnIndex: 0,
    ...overrides,
  };
}

describe('TokenBar', () => {
  afterEach(cleanup);
  it('renders nothing when no tokens have been tracked', () => {
    const { container } = render(<TokenBar tokenState={makeState()} />);
    expect(container.querySelector('.token-bar')).toBeNull();
  });

  it('renders agent context with brain icon', () => {
    render(<TokenBar tokenState={makeState({ agentContext: 87204, turnIndex: 1 })} />);
    // Should show formatted token count
    expect(screen.getByText(/87k/)).toBeTruthy();
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
    expect(screen.getByText(/143k/)).toBeTruthy();
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
