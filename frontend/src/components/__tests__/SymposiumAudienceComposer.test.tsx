// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SymposiumAudienceComposer } from '../SymposiumAudienceComposer';

afterEach(cleanup);

it('keeps separate drafts when switching through read-only All', async () => {
  const onQueue = vi.fn(async () => true);
  const props = { recipients: ['reviewer'], enabled: true, onQueue };
  const { rerender } = render(
    <SymposiumAudienceComposer {...props} audience="reviewer" audienceLabel="Reviewer" />,
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message for Reviewer' }),
    'Private review question',
  );
  rerender(
    <SymposiumAudienceComposer {...props} audience="all" audienceLabel="All admitted seats" />,
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Queue for approval' })).toBeNull();
  expect(screen.getByText(/Select an agent stream/)).toBeTruthy();
  rerender(<SymposiumAudienceComposer {...props} audience="reviewer" audienceLabel="Reviewer" />);
  expect(
    (screen.getByRole('textbox', { name: 'Message for Reviewer' }) as HTMLTextAreaElement).value,
  ).toBe('Private review question');
  await userEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  expect(onQueue).toHaveBeenCalledWith(['reviewer'], 'Private review question');
});

it('does not queue a message when recipient admission is unavailable', async () => {
  const onQueue = vi.fn(async () => true);
  render(
    <SymposiumAudienceComposer
      audience="reviewer"
      audienceLabel="Reviewer"
      recipients={[]}
      enabled={false}
      onQueue={onQueue}
    />,
  );
  expect(screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByText(/Provider admission is pending/)).toBeTruthy();
});

it('switches an @ recipient by exact seat ID even when names collide, retaining per-agent drafts', async () => {
  const onQueue = vi.fn(async () => true);
  const onSelectRecipient = vi.fn();
  render(
    <SymposiumAudienceComposer
      audience="agent-one"
      audienceLabel="Analyst"
      recipients={['agent-one']}
      enabled
      onQueue={onQueue}
      onSelectRecipient={onSelectRecipient}
      seats={[
        { id: 'agent-one', name: 'Analyst' },
        { id: 'agent-two', name: 'Analyst' },
      ]}
    />,
  );
  await userEvent.type(screen.getByRole('textbox', { name: 'Message for Analyst' }), 'Question @');
  await userEvent.click(screen.getByRole('button', { name: 'Analyst · nt-two' }));
  expect(onSelectRecipient).toHaveBeenCalledWith('agent-two');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Question ');
  expect(onQueue).not.toHaveBeenCalled();
});
it('treats raw email and unknown @ text as content without changing recipient IDs', async () => {
  const onQueue = vi.fn(async () => true);
  const onSelectRecipient = vi.fn();
  render(
    <SymposiumAudienceComposer
      audience="agent-one"
      audienceLabel="Analyst"
      recipients={['agent-one']}
      enabled
      onQueue={onQueue}
      onSelectRecipient={onSelectRecipient}
      seats={[{ id: 'agent-one', name: 'Analyst' }]}
    />,
  );
  await userEvent.type(screen.getByRole('textbox'), 'Check person@example.test and @unknown');
  expect(onSelectRecipient).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: 'Queue for approval' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Close recipient picker' }));
  await userEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  expect(onQueue).toHaveBeenCalledWith(['agent-one'], 'Check person@example.test and @unknown');
});

it('prevents queuing an unresolved @ target to the current agent and hides full seat identifiers', async () => {
  const onQueue = vi.fn(async () => true);
  const onSelectRecipient = vi.fn();
  const currentId = 'agent-43b8aab6-5eed-451d-8511-83a9d3a8e147';
  const reviewerId = 'agent-2a39c9a0-ecbd-4f29-8dbf-724286c64865';
  render(
    <SymposiumAudienceComposer
      audience={currentId}
      audienceLabel="Custom analyst"
      recipients={[currentId]}
      enabled
      onQueue={onQueue}
      onSelectRecipient={onSelectRecipient}
      seats={[
        { id: currentId, name: 'Custom analyst', role: 'analyst' },
        { id: reviewerId, name: 'Reviewer', role: 'reviewer' },
      ]}
    />,
  );
  await userEvent.type(screen.getByRole('textbox'), 'Please inspect @rev');
  const queue = screen.getByRole('button', { name: 'Queue for approval' });
  expect((queue as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(queue);
  expect(onQueue).not.toHaveBeenCalled();
  expect(screen.queryByText(reviewerId)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Reviewer · reviewer' }));
  expect(onSelectRecipient).toHaveBeenCalledWith(reviewerId);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Please inspect ');
  expect(onQueue).not.toHaveBeenCalled();
});
