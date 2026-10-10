import { expect, it } from 'vitest';
import { recordTitle } from '../record-title';

it('uses the first meaningful heading or line without including the saved body', () => {
  expect(recordTitle('\n\n# Canonical recovery\n\nFull handover details.')).toBe(
    'Canonical recovery',
  );
  expect(recordTitle('## Recovery plan ##\nMore details')).toBe('Recovery plan');
  expect(recordTitle('A plain title\n================\nBody')).toBe('A plain title');
  expect(recordTitle('[mitzo#1] Fix bug')).toBe('[mitzo#1] Fix bug');
  expect(recordTitle(' \n ')).toBe('Untitled');
});

it('bounds a prose-only title while leaving the source intact', () => {
  const summary = 'x'.repeat(1000);
  expect(recordTitle(summary)).toHaveLength(200);
  expect(recordTitle(summary).endsWith('…')).toBe(true);
  expect(summary).toHaveLength(1000);
});
