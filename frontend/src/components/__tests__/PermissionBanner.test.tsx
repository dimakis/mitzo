// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { PermissionBanner } from '../PermissionBanner';

const defaultProps = {
  permId: 'p1',
  toolName: 'Bash',
  toolInput: 'echo hello',
  onRespond: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PermissionBanner', () => {
  it('renders tier badge with correct class for elevated tier', () => {
    const { container } = render(<PermissionBanner {...defaultProps} tier="elevated" />);
    expect(container.querySelector('.perm-banner--elevated')).toBeTruthy();
    expect(screen.getByText('Shell Access')).toBeTruthy();
  });

  it('shows title when provided, falls back to toolName', () => {
    render(<PermissionBanner {...defaultProps} title="Custom Title" />);
    expect(screen.getByText('Custom Title')).toBeTruthy();
  });

  it('falls back to displayName then toolName', () => {
    render(<PermissionBanner {...defaultProps} displayName="Display Name" />);
    expect(screen.getByText('Display Name')).toBeTruthy();
  });

  it('Allow Once calls onRespond with correct args', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Allow Once'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'Bash');
  });

  it('session allowance calls onRespond with correct args', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Allow for session'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'always', 'Bash');
  });

  it('Deny calls onRespond with deny', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('Deny'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });

  it('auto-deny fires when timer reaches 0', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });

  it('renders all action buttons with correct CSS classes', () => {
    const { container } = render(<PermissionBanner {...defaultProps} />);
    expect(container.querySelector('.perm-banner-btn--once')).toBeTruthy();
    expect(container.querySelector('.perm-banner-btn--always')).toBeTruthy();
    expect(container.querySelector('.perm-banner-btn--deny')).toBeTruthy();
  });

  it('adds perm-banner--visible class after mount', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    try {
      const { container } = render(<PermissionBanner {...defaultProps} />);
      expect(container.querySelector('.perm-banner--visible')).toBeTruthy();
    } finally {
      rafSpy.mockRestore();
    }
  });

  it('renders questions as choices and returns answers instead of an approval', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        toolName="AskUserQuestion"
        onRespond={onRespond}
        questions={[
          {
            id: 'account',
            question: 'Which account?',
            header: 'Account',
            multiSelect: false,
            options: [
              { label: 'Personal', description: 'ChatGPT plan' },
              { label: 'Work', description: 'API billing' },
            ],
          },
        ]}
      />,
    );
    expect(screen.queryByText('Always Allow')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText(/Personal/));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'AskUserQuestion', {
      account: ['Personal'],
    });
  });
  it('accepts a free-text answer and multiple selections', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        toolName="AskUserQuestion"
        onRespond={onRespond}
        questions={[
          {
            id: 'q',
            question: 'Which features?',
            header: 'Features',
            multiSelect: true,
            options: [
              { label: 'Chat', description: '' },
              { label: 'Tools', description: '' },
            ],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText('Chat'));
    fireEvent.click(screen.getByLabelText('Tools'));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Also voice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'AskUserQuestion', {
      q: ['Chat', 'Tools', 'Also voice'],
    });
  });
  it('uses the server deadline after reconnect instead of restarting two minutes', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner {...defaultProps} onRespond={onRespond} expiresAt={Date.now() + 3000} />,
    );
    act(() => vi.advanceTimersByTime(3000));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });
  it('shows full approval input and explains the scope of session allowance', () => {
    const input = 'x'.repeat(450);
    render(<PermissionBanner {...defaultProps} toolInput={input} />);
    expect(screen.getByText(input)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow for session' })).toBeTruthy();
  });

  it('accepts provider question IDs that match object prototype names', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        toolName="AskUserQuestion"
        onRespond={onRespond}
        questions={[
          {
            id: 'constructor',
            question: 'Choose',
            header: 'Choice',
            multiSelect: false,
            options: [{ label: 'Yes', description: '' }],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'AskUserQuestion', {
      constructor: ['Yes'],
    });
  });
});

it('hides free text for restricted choices and masks secret input', () => {
  const { container } = render(
    <PermissionBanner
      {...defaultProps}
      questions={[
        {
          id: 'choice',
          question: 'Choose one',
          header: 'Choice',
          options: [{ label: 'Work', description: '' }],
          multiSelect: false,
          allowFreeform: false,
        },
        {
          id: 'secret',
          question: 'Enter secret',
          header: 'Secret',
          options: [],
          multiSelect: false,
          isSecret: true,
        },
      ]}
    />,
  );
  expect(container.querySelectorAll('textarea')).toHaveLength(0);
  expect(container.querySelector('input[type="password"]')).toBeTruthy();
});
