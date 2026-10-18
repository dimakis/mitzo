// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
import { TelosLinkedContext } from '../TelosLinkedContext';

afterEach(cleanup);

it('CT05: explains the reviewed goal, parent outcome, item and done criteria in the approved order', () => {
  // Existing retained context only. No proposed presentation DTO is smuggled
  // into this regression while its accepted-source dependency remains open.
  const context: TelosWorkRoleContextSelection = {
    version: 1,
    itemId: 'recording',
    role: 'worker',
    brief: {
      revision: 'brief-v2',
      sha256: 'a'.repeat(64),
      text: JSON.stringify({
        summary: 'Record an agreed session',
        intent: 'Make the first recording',
        acceptanceCriteria: ['The reviewed recording is retained'],
      }),
    },
    overallGoal: {
      itemId: 'studio',
      revision: 'goal-v1',
      text: 'Create a home studio',
    },
    parentCriteria: [
      {
        itemId: 'session-plan',
        revision: 'parent-v3',
        criteria: ['The session stays within the agreed budget'],
      },
    ],
    sources: [],
    artifacts: [],
  };
  render(
    <MemoryRouter>
      <TelosLinkedContext context={context} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Linked brief · goal & parent context'));

  const labels = new Set(['Overall goal', 'Parent outcome', 'This item', 'Done when']);
  expect(
    screen
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
      .filter((label) => label !== null && labels.has(label)),
  ).toEqual(['Overall goal', 'Parent outcome', 'This item', 'Done when']);

  expect(screen.getByText(context.overallGoal.text)).toBeTruthy();
  expect(screen.getByText('Make the first recording')).toBeTruthy();
  expect(screen.getByText(context.parentCriteria[0].criteria[0])).toBeTruthy();
  expect(screen.getByText('The reviewed recording is retained')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open overall goal' }).getAttribute('href')).toBe(
    '/todos/studio',
  );
  expect(screen.getByRole('link', { name: 'Parent item' }).getAttribute('href')).toBe(
    '/todos/session-plan',
  );
});
