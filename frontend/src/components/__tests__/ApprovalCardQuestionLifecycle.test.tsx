// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useLayoutEffect, useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalCard, type ApprovalCardProps } from '../ApprovalCard';

const question = {
  id: 'q',
  header: 'Target',
  question: 'Where?',
  multiSelect: false,
  options: [
    { label: 'North', description: 'First target' },
    { label: 'South', description: 'Second target' },
  ],
};
const request = {
  sessionId: 'session-one',
  permId: 'request-one',
  toolName: 'AskUserQuestion',
  toolInput: '{}',
  questions: [question],
};

afterEach(cleanup);

function AnswerAsQuestionAppears(props: ApprovalCardProps) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Exercise an interaction after the inputs commit but before passive effects.
    host.current!.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
  }, []);
  return (
    <div ref={host}>
      <ApprovalCard {...props} />
    </div>
  );
}

it('retains the first answer chosen before passive effects flush', () => {
  const onRespond = vi.fn();
  render(<AnswerAsQuestionAppears {...request} onRespond={onRespond} />);
  expect(screen.getByRole('radio', { name: /North/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(onRespond).toHaveBeenCalledExactlyOnceWith('request-one', 'once', 'AskUserQuestion', {
    q: ['North'],
  });
});

it.each(['request', 'session'])('starts fresh when the %s identity changes', (identity) => {
  const onRespond = vi.fn();
  const { rerender } = render(<ApprovalCard {...request} onRespond={onRespond} />);
  fireEvent.click(screen.getByRole('radio', { name: /North/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(onRespond).toHaveBeenCalledExactlyOnceWith('request-one', 'once', 'AskUserQuestion', {
    q: ['North'],
  });

  const next =
    identity === 'request'
      ? { ...request, permId: 'request-two' }
      : { ...request, sessionId: 'session-two' };
  rerender(<ApprovalCard {...next} onRespond={onRespond} />);
  expect(screen.getByRole('radio', { name: /North/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /South/ }));
  expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(onRespond).toHaveBeenLastCalledWith(next.permId, 'once', 'AskUserQuestion', {
    q: ['South'],
  });
  expect(onRespond).toHaveBeenCalledTimes(2);
});
