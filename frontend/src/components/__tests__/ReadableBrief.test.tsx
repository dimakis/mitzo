// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReadableBrief } from '../ReadableBrief';
afterEach(cleanup);
it('starts with a bounded excerpt and reveals the entire formatted brief on request', async () => {
  const text =
    '# Review\n\n' +
    'Source evidence needs review. '.repeat(50) +
    '\n\n- Preserve the original answers\n- Ask for manager assessment';
  render(
    <MemoryRouter>
      <ReadableBrief text={text} />
    </MemoryRouter>,
  );
  const disclosure = screen.getByText('Full brief').closest('details')!;
  expect(disclosure.open).toBe(false);
  expect(screen.getByLabelText('Brief summary').textContent!.length).toBeLessThanOrEqual(321);
  fireEvent.click(screen.getByText('Full brief'));
  expect(disclosure.open).toBe(true);
  expect(await screen.findByRole('heading', { name: 'Review' })).toBeTruthy();
  expect(screen.getByText('Preserve the original answers')).toBeTruthy();
});
it('renders a short brief once without a redundant disclosure', () => {
  render(
    <MemoryRouter>
      <ReadableBrief text="Review the associate’s accomplishments." />
    </MemoryRouter>,
  );
  expect(screen.getAllByText('Review the associate’s accomplishments.')).toHaveLength(1);
  expect(screen.queryByText('Full brief')).toBeNull();
});
