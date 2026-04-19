// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { CopyButton } from '../CopyButton';

vi.mock('../../lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

afterEach(() => cleanup());

describe('CopyButton', () => {
  it('renders with default aria-label', () => {
    render(<CopyButton text="hello" />);
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy();
  });

  it('renders with custom className', () => {
    render(<CopyButton text="hello" className="my-class" />);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('my-class');
  });

  it('shows checkmark after click', async () => {
    render(<CopyButton text="hello" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('applies copy-btn--copied class after click', async () => {
    render(<CopyButton text="hello" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('button').className).toContain('copy-btn--copied');
  });
});
