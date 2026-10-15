// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MockupCollection } from '../MockupCollection';
import type { Mockup } from '../../lib/mockup-catalog';
vi.mock('../HtmlPreviewCard', () => ({
  HtmlPreviewCard: ({ filePath, sessionId }: { filePath: string; sessionId?: string }) => (
    <p role="status">
      {sessionId}:{filePath}
    </p>
  ),
}));
afterEach(cleanup);
const mockups: Mockup[] = Array.from({ length: 18 }, (_, i) => ({
  id: `/task/mockups/design-${i}`,
  title: `Design ${i}`,
  revisions: [3, 1].map((number) => ({
    path: `/task/mockups/design-${i}/v00${number}.html`,
    number,
    messageId: `m${number}`,
  })),
}));
it('bounds a large collection, filters it, and opens one selected revision without losing search', () => {
  render(<MockupCollection mockups={mockups} sessionId="chat-a" />);
  expect(screen.getAllByRole('button', { name: /^Open Design/ })).toHaveLength(8);
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next mockups' }));
  expect(screen.getByRole('button', { name: 'Open Design 8' })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search mockups' }), {
    target: { value: 'Design 17' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open Design 17' }));
  expect(screen.getByRole('status').textContent).toBe('chat-a:/task/mockups/design-17/v003.html');
  fireEvent.change(screen.getByRole('combobox', { name: 'Revision' }), {
    target: { value: '/task/mockups/design-17/v001.html' },
  });
  expect(screen.getByRole('status').textContent).toBe('chat-a:/task/mockups/design-17/v001.html');
  fireEvent.click(screen.getByRole('button', { name: 'Back to mockups' }));
  expect(
    (screen.getByRole('searchbox', { name: 'Search mockups' }) as HTMLInputElement).value,
  ).toBe('Design 17');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Design 17' }));
});
it('distinguishes an empty collection from an empty search and never displays a removed selection', () => {
  const view = render(<MockupCollection mockups={[]} sessionId="a" />);
  expect(screen.getByText(/No mockups linked/)).toBeTruthy();
  view.rerender(<MockupCollection mockups={mockups} sessionId="a" />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search mockups' }), {
    target: { value: 'missing' },
  });
  expect(screen.getByText('No matching mockups.')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search mockups' }), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open Design 0' }));
  view.rerender(<MockupCollection mockups={[]} sessionId="a" />);
  expect(screen.queryByRole('status')).toBeNull();
});
