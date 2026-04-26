// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReadAloudButton } from '../ReadAloudButton';
import { TextBubble, UserBubble } from '../MessageBubble';

afterEach(() => cleanup());

describe('ReadAloudButton', () => {
  it('renders speaker icon when idle', () => {
    render(<ReadAloudButton text="Hello" active={false} onSpeak={vi.fn()} onStop={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Read aloud' });
    expect(btn.textContent).toBe('\u{1F50A}');
  });

  it('renders stop icon when active', () => {
    render(<ReadAloudButton text="Hello" active={true} onSpeak={vi.fn()} onStop={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Stop reading' });
    expect(btn.textContent).toBe('\u23F9');
  });

  it('calls onSpeak with text when clicked while idle', () => {
    const onSpeak = vi.fn();
    render(
      <ReadAloudButton text="Hello world" active={false} onSpeak={onSpeak} onStop={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSpeak).toHaveBeenCalledWith('Hello world');
  });

  it('calls onStop when clicked while active', () => {
    const onStop = vi.fn();
    render(<ReadAloudButton text="Hello" active={true} onSpeak={vi.fn()} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('applies className and active class', () => {
    const { container } = render(
      <ReadAloudButton
        text="Hello"
        active={true}
        onSpeak={vi.fn()}
        onStop={vi.fn()}
        className="custom-class"
      />,
    );
    const btn = container.querySelector('button');
    expect(btn?.classList.contains('read-aloud-btn')).toBe(true);
    expect(btn?.classList.contains('read-aloud-btn--active')).toBe(true);
    expect(btn?.classList.contains('custom-class')).toBe(true);
  });
});

describe('graceful degradation — no readAloud prop', () => {
  it('TextBubble does not render read-aloud button when readAloud is undefined', () => {
    const { container } = render(
      <MemoryRouter>
        <TextBubble content="Hello world" />
      </MemoryRouter>,
    );
    expect(container.querySelector('.read-aloud-btn')).toBeNull();
  });

  it('UserBubble does not render read-aloud button when readAloud is undefined', () => {
    const { container } = render(<UserBubble text="Hello world" />);
    expect(container.querySelector('.read-aloud-btn')).toBeNull();
  });
});
