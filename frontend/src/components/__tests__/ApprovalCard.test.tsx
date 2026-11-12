// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../ApprovalCard';
const base = { permId: 'p', toolName: 'Bash', toolInput: 'npm test', onRespond: vi.fn() };
afterEach(cleanup);
it.each(['npm test', 'npm run build'])(
  'identifies the original operation %s beside approval even with a generic title and session summary',
  (toolInput) => {
    render(
      <ApprovalCard
        {...base}
        title="Run command?"
        summary="Same conversation"
        toolInput={toolInput}
      />,
    );
    expect(screen.getByText(toolInput).closest('.operation-header')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Request details' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  },
);

it.each([undefined, false, true])(
  'keeps once approval in the header with session retention %s',
  (allowSessionGrant) => {
    const respond = vi.fn();
    render(<ApprovalCard {...base} onRespond={respond} allowSessionGrant={allowSessionGrant} />);
    const approve = screen.getByRole('button', { name: 'Approve once' });
    expect(approve.closest('.operation-header')).not.toBeNull();
    fireEvent.click(approve);
    expect(respond).toHaveBeenCalledWith('p', 'once', 'Bash');
  },
);

it.each(['chat', 'notification'] as const)(
  'always offers conversation Grant on %s even without a session allowance',
  (responseTransport) => {
    const respond = vi.fn();
    render(
      <ApprovalCard
        {...base}
        toolName="RequestConnectionAccess"
        approvalScope="conversation"
        allowSessionGrant={false}
        onRespond={respond}
        responseTransport={responseTransport}
      />,
    );
    const grant = screen.getByRole('button', { name: 'Grant to conversation' });
    expect(grant.closest('.operation-header')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
    fireEvent.click(grant);
    expect(respond).toHaveBeenCalledWith(
      'p',
      responseTransport === 'notification' ? 'always' : 'once',
      'RequestConnectionAccess',
    );
  },
);

it('keeps question submission at the top and requires the original answer', () => {
  const respond = vi.fn();
  render(
    <ApprovalCard
      {...base}
      onRespond={respond}
      questions={[
        {
          id: 'q',
          header: 'Target',
          question: 'Where?',
          multiSelect: false,
          options: [{ label: 'Local Mac', description: 'This Mac' }],
        },
      ]}
    />,
  );
  const send = screen.getByRole('button', { name: 'Send answer' });
  expect(send.closest('.operation-header')).not.toBeNull();
  expect(send).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /Local Mac/ }));
  fireEvent.click(send);
  expect(respond).toHaveBeenCalledWith('p', 'once', 'Bash', { q: ['Local Mac'] });
});
