// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  ComposerStatusProvider,
  ComposerStatusRail,
  ComposerStatusNotice,
} from '../ComposerStatus';
import { ChatStatusMessage } from '../ChatStatusMessage';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps one mounted summary while notices change and exposes every action in details', () => {
  const retry = vi.fn();
  function Fixture({ error }: { error?: string }) {
    return (
      <ComposerStatusProvider>
        <ChatStatusMessage status="Connecting to a very long provider name" busy />
        <ChatStatusMessage error={error} action={{ label: 'Retry correction', onClick: retry }} />
        <ComposerStatusRail running />
        <textarea aria-label="Next draft" defaultValue="Keep this draft" />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture />);
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  view.rerender(<Fixture error="Correction delivery failed" />);
  expect(screen.getByRole('region', { name: 'Conversation status' })).toBe(rail);
  expect(within(rail).getByRole('alert').textContent).toContain('Correction delivery failed');
  expect(screen.queryByRole('button', { name: 'Retry correction' })).toBeNull();
  fireEvent.click(within(rail).getByRole('button', { name: 'Conversation status details' }));
  const dialog = screen.getByRole('dialog', { name: 'Conversation status' });
  expect(within(dialog).getByText('Connecting to a very long provider name')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry correction' }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.getByLabelText('Next draft')).toHaveProperty('value', 'Keep this draft');
});

it('combines simultaneous problems and retains the remaining problem after one clears', () => {
  function Fixture({ first = true }: { first?: boolean }) {
    return (
      <ComposerStatusProvider>
        {first && <ComposerStatusNotice message="Approval required" tone="warning" />}
        <ComposerStatusNotice message="Draft not saved" tone="danger" />
        <ComposerStatusRail running />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture />);
  expect(screen.getByRole('alert').textContent).toBe('Needs attention · 2 issues');
  view.rerender(<Fixture first={false} />);
  expect(screen.getByRole('alert').textContent).toBe('Draft not saved');
});

it('opens the existing queued controls from the count without mounting another status row', () => {
  const edit = vi.fn();
  render(
    <ComposerStatusProvider>
      <ComposerStatusNotice message="Up next" queued={2}>
        <button onClick={edit}>Edit queued prompt</button>
      </ComposerStatusNotice>
      <ComposerStatusRail running />
    </ComposerStatusProvider>,
  );
  expect(screen.getByRole('status').textContent).toBe('Working');
  fireEvent.click(screen.getByRole('button', { name: '2 queued messages' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued prompt' }));
  expect(edit).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('region', { name: 'Conversation status' })).toHaveLength(1);
});

it('retains standalone feedback when there is no composer to own the rail', () => {
  render(
    <ComposerStatusProvider>
      <ChatStatusMessage error="Failed admission" />
    </ComposerStatusProvider>,
  );
  expect(screen.getByRole('alert').textContent).toBe('Failed admission');
});
