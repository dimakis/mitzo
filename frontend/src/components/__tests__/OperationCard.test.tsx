// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationCard } from '../OperationCard';
afterEach(cleanup);

it('keeps the primary action beside the operation and outside optional scrolling details', () => {
  const approve = vi.fn();
  render(
    <OperationCard
      title="Run the tests"
      kind="Command"
      icon="terminal"
      scope="Once · workspace only"
      actions={<button onClick={approve}>Approve</button>}
      details={<pre>{'Long evidence\n'.repeat(100)}</pre>}
    />,
  );
  const action = screen.getByRole('button', { name: 'Approve' });
  expect(action.closest('.operation-header')).toContainElement(
    screen.getByRole('heading', { name: 'Run the tests' }),
  );
  expect(screen.queryByText(/Long evidence/)).not.toBeInTheDocument();
  fireEvent.click(action);
  expect(approve).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /Details/ }));
  expect(screen.getByText(/Long evidence/)).toBeVisible();
  expect(action.closest('.operation-details')).toBeNull();
});

it('retains failure state and full output through the same disclosure', () => {
  render(
    <OperationCard
      title="Build frontend"
      kind="Command"
      icon="terminal"
      status="Failed"
      tone="error"
      details={<pre>Heap limit exceeded</pre>}
    />,
  );
  expect(screen.getByText('Failed')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Details/ }));
  expect(screen.getByText('Heap limit exceeded')).toBeVisible();
});
