// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SymposiumAudienceComposer } from '../SymposiumAudienceComposer';

afterEach(cleanup);

it('keeps separate drafts when switching between All and a seat', async () => {
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
  expect(
    (screen.getByRole('textbox', { name: 'Message for All admitted seats' }) as HTMLTextAreaElement)
      .value,
  ).toBe('');
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message for All admitted seats' }),
    'Shared note',
  );
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
