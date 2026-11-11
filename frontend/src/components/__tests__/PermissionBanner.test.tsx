// @vitest-environment jsdom
import { approvalAction, queryApprovalAction } from './approval-action-helper';
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
  it('preserves written answers and releases busy for repeated identical immediate failures', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        onRespond={onRespond}
        responseError="Reconnect and try again."
        questions={[
          { id: 'q', header: 'Choice', question: 'Choose?', multiSelect: false, options: [] },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'Keep this answer' },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(approvalAction('Send answer'));
      expect(approvalAction('Send answer').hasAttribute('disabled')).toBe(false);
      expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
        'Keep this answer',
      );
    }
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond).toHaveBeenLastCalledWith('p1', 'once', 'Bash', { q: ['Keep this answer'] });
  });

  it('shows response progress, prevents duplicates and allows retry after failure', () => {
    const onRespond = vi.fn();
    const { rerender } = render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(approvalAction('Approve once'));
    expect(screen.getByRole('status').textContent).toContain('Sending response');
    fireEvent.click(approvalAction('Approve once'));
    expect(onRespond).toHaveBeenCalledTimes(1);
    rerender(
      <PermissionBanner {...defaultProps} onRespond={onRespond} responseError="Try again" />,
    );
    expect(approvalAction('Approve once').hasAttribute('disabled')).toBe(false);
    fireEvent.click(approvalAction('Approve once'));
    expect(onRespond).toHaveBeenCalledTimes(2);
  });

  it('uses the server-owned scope explanation for session retention', () => {
    render(
      <PermissionBanner
        {...defaultProps}
        approvalScope="request"
        sessionGrantDescription="Keep website access for this domain until the session ends."
      />,
    );
    expect(
      screen.getByText('Keep website access for this domain until the session ends.'),
    ).toBeTruthy();
    expect(approvalAction('Approve for session')).toBeTruthy();
  });
  it('keeps approval visible with details closed and preserves expansion until the next request', () => {
    const { rerender } = render(<PermissionBanner {...defaultProps} />);
    const details = () => screen.getByRole('button', { name: 'Request details' });
    expect(details().getAttribute('aria-expanded')).toBe('false');
    expect(approvalAction('Approve once')).toBeTruthy();
    fireEvent.click(details());
    expect(details().getAttribute('aria-expanded')).toBe('true');
    rerender(<PermissionBanner {...defaultProps} responseError="Try again" />);
    expect(details().getAttribute('aria-expanded')).toBe('true');
    rerender(<PermissionBanner {...defaultProps} permId="next" />);
    expect(details().getAttribute('aria-expanded')).toBe('false');
  });

  it('renders at the document root so mobile navigation cannot cover its actions', () => {
    render(<PermissionBanner {...defaultProps} />);

    expect(screen.getByLabelText('Approval required').parentElement).toBe(document.body);
  });

  it('renders tier badge with correct class for elevated tier', () => {
    render(<PermissionBanner {...defaultProps} tier="elevated" />);
    expect(
      screen.getByLabelText('Approval required').classList.contains('perm-banner--elevated'),
    ).toBe(true);
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

  it('Approve once calls onRespond with correct args', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(approvalAction('Approve once'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'Bash');
  });

  it('session allowance calls onRespond with correct args', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(approvalAction('Approve for session'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'always', 'Bash');
  });

  it('Deny calls onRespond with deny', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    fireEvent.click(approvalAction('Deny'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });

  it('local expiry does not fabricate a user denial', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} onRespond={onRespond} />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('removes the expired card even when the timeout response is rejected', () => {
    const onRespond = vi.fn();
    const { rerender } = render(
      <PermissionBanner {...defaultProps} onRespond={onRespond} expiresAt={Date.now() + 1000} />,
    );
    act(() => vi.advanceTimersByTime(1000));
    rerender(
      <PermissionBanner
        {...defaultProps}
        onRespond={onRespond}
        expiresAt={Date.now()}
        responseError="Could not submit the permission response (409)."
      />,
    );
    expect(screen.queryByLabelText('Approval required')).toBeNull();
  });

  it('does not show an expired request restored from history', () => {
    render(<PermissionBanner {...defaultProps} expiresAt={Date.now() - 1000} />);
    expect(screen.queryByLabelText('Approval required')).toBeNull();
  });

  it('removes the permission from local state without submitting a timeout denial', () => {
    const calls: string[] = [];
    const onExpire = vi.fn(() => calls.push('expire'));
    const onRespond = vi.fn(() => calls.push('deny'));
    render(
      <PermissionBanner
        {...defaultProps}
        expiresAt={Date.now() + 1000}
        onExpire={onExpire}
        onRespond={onRespond}
      />,
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(onExpire).toHaveBeenCalledExactlyOnceWith('p1');
    expect(calls).toEqual(['expire']);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('keeps the primary action in the shared header and secondary decisions in its menu', () => {
    render(<PermissionBanner {...defaultProps} />);
    expect(approvalAction('Approve once').closest('.operation-header')).toBeTruthy();
    expect(approvalAction('Approve for session').getAttribute('role')).toBe('menuitem');
    expect(approvalAction('Deny').getAttribute('role')).toBe('menuitem');
  });

  it('shows a retryable permission response error without dismissing the prompt', () => {
    render(<PermissionBanner {...defaultProps} responseError="Review the prompt and try again." />);
    expect(screen.getByRole('alert').textContent).toContain('Review the prompt and try again.');
    expect(approvalAction('Approve once')).toBeTruthy();
  });

  it('adds perm-banner--visible class after mount', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    try {
      render(<PermissionBanner {...defaultProps} />);
      expect(document.querySelector('.perm-banner--visible')).toBeTruthy();
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
    expect(approvalAction('Send answer').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText(/Personal/));
    fireEvent.click(approvalAction('Send answer'));
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
    fireEvent.click(approvalAction('Send answer'));
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
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Approval required')).toBeNull();
  });
  it('shows full approval input and explains the scope of session allowance', () => {
    const input = 'x'.repeat(450);
    render(<PermissionBanner {...defaultProps} toolInput={input} />);
    expect(screen.getByText(input)).toBeTruthy();
    expect(approvalAction('Approve for session')).toBeTruthy();
  });

  it('offers the durable conversation grant without a misleading session allowance', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        toolName="GrantIntegrationAccess"
        approvalScope="conversation"
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText(/across reconnects and Mitzo restarts/)).toBeTruthy();
    expect(queryApprovalAction('Approve once')).toBeNull();
    expect(queryApprovalAction('Approve for session')).toBeNull();
    fireEvent.click(approvalAction('Grant to conversation'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'GrantIntegrationAccess');
  });

  it('describes session search consent with its account, model and website limits', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        toolName="RequestWebAccess"
        approvalScope="session"
        toolInput={JSON.stringify({ operation: 'search', query: 'Pricing' })}
        onRespond={onRespond}
      />,
    );
    expect(
      screen.getByText(
        'Allow searches on this account and model until the session ends. Website access stays separate.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText('Session allowance covers this tool until the task ends.'),
    ).toBeNull();
    expect(approvalAction('Approve searches for this session')).toBeTruthy();
    fireEvent.click(approvalAction('Approve searches for this session'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'always', 'RequestWebAccess');
  });
  it.each(['RequestWebAccess', 'GitCommit', 'Bash', 'ExecuteProviderCapability'])(
    'offers session retention for exact %s requests',
    (toolName) => {
      render(<PermissionBanner {...defaultProps} toolName={toolName} approvalScope="request" />);
      expect(approvalAction('Approve once')).toBeTruthy();
      expect(approvalAction('Approve for session')).toBeTruthy();
      expect(
        screen.getByText(
          'Allow once covers the displayed request. Allow for session keeps this approval until the session ends.',
        ),
      ).toBeTruthy();
    },
  );
  it.each(['TelosCreateOutcome', 'TelosSaveArtifact', 'mcp__telos__TelosSaveArtifact'])(
    'advertises the shared Telos server scope for %s session grants',
    (toolName) => {
      render(<PermissionBanner {...defaultProps} toolName={toolName} />);
      expect(screen.getByText('Session allowance covers all telos tools.')).toBeTruthy();
      expect(approvalAction('Approve for session')).toBeTruthy();
    },
  );

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
    fireEvent.click(approvalAction('Send answer'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'AskUserQuestion', {
      constructor: ['Yes'],
    });
  });
});

it('hides free text for restricted choices and masks secret input', () => {
  render(
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
  expect(document.querySelectorAll('.perm-banner textarea')).toHaveLength(0);
  expect(document.querySelector('.perm-banner input[type="password"]')).toBeTruthy();
});

describe('host session-grant display policy', () => {
  it.each(['request', 'session', undefined] as const)(
    'offers only Once and Deny when session grants are explicitly false (scope %s)',
    (approvalScope) => {
      const onRespond = vi.fn();
      render(
        <PermissionBanner
          {...defaultProps}
          approvalScope={approvalScope}
          allowSessionGrant={false}
          sessionGrantDescription="Keep this approval until the session ends."
          onRespond={onRespond}
        />,
      );
      expect(queryApprovalAction('Approve for session')).toBeNull();
      expect(screen.queryByText('Keep this approval until the session ends.')).toBeNull();
      expect(screen.getByText('Allow once covers the displayed request.')).toBeTruthy();
      fireEvent.click(approvalAction('Approve once'));
      expect(onRespond).toHaveBeenCalledOnce();
      expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'Bash');
    },
  );
  it('does not offer an account/model session search grant when explicitly false', () => {
    render(
      <PermissionBanner
        {...defaultProps}
        allowSessionGrant={false}
        toolName="RequestWebAccess"
        approvalScope="session"
        toolInput={JSON.stringify({ operation: 'search', query: 'Pricing' })}
      />,
    );
    expect(queryApprovalAction('Approve searches for this session')).toBeNull();
    expect(screen.getByText('Allow once covers the displayed request.')).toBeTruthy();
  });
  it('keeps the existing conversation grant action when only session grants are unavailable', () => {
    const onRespond = vi.fn();
    render(
      <PermissionBanner
        {...defaultProps}
        approvalScope="conversation"
        allowSessionGrant={false}
        onRespond={onRespond}
      />,
    );
    expect(queryApprovalAction('Approve for session')).toBeNull();
    expect(
      screen.getByText(/This integration remains available to this conversation across reconnects/),
    ).toBeTruthy();
    fireEvent.click(approvalAction('Grant to conversation'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'once', 'Bash');
  });
  it('retains Deny for an explicitly once-only request', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner {...defaultProps} allowSessionGrant={false} onRespond={onRespond} />);
    fireEvent.click(approvalAction('Deny'));
    expect(onRespond).toHaveBeenCalledWith('p1', 'deny', 'Bash');
  });
  it.each([undefined, true])(
    'preserves ordinary request-scope session allowance for %s',
    (allowSessionGrant) => {
      const onRespond = vi.fn();
      render(
        <PermissionBanner
          {...defaultProps}
          approvalScope="request"
          allowSessionGrant={allowSessionGrant}
          sessionGrantDescription="Keep workspace checks until the session ends."
          onRespond={onRespond}
        />,
      );
      expect(screen.getByText('Keep workspace checks until the session ends.')).toBeTruthy();
      fireEvent.click(approvalAction('Approve for session'));
      expect(onRespond).toHaveBeenCalledWith('p1', 'always', 'Bash');
    },
  );
});
