// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SessionResourcesDialog } from '../SessionResourcesDialog';
vi.mock('../ContextPanel', () => ({ ContextPanel: () => <p>Context blocks available</p> }));
vi.mock('../SessionBanner', () => ({ SessionBanner: () => <p>Injected boot context</p> }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
const props = {
  messages: [],
  selectedContextBlocks: [],
  draftImages: [],
  onToggleContextBlock: vi.fn(),
  onAddImages: vi.fn(),
  onRemoveImage: vi.fn(),
};
it('puts boot injection and selectable blocks in Context, separate from Sources', () => {
  render(<SessionResourcesDialog {...props} bootContext={{} as never} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  expect(screen.getByText('Injected boot context')).toBeTruthy();
  expect(screen.getByText('Context blocks available')).toBeTruthy();
});
it('bounds hundreds of references, preserves filters, and closes a PR back into Resources', () => {
  const content =
    Array.from({ length: 264 }, (_, i) => `https://site${i % 112}.example/page${i}`).join('\n') +
    '\nhttps://github.com/acme/widgets/pull/12';
  render(
    <SessionResourcesDialog
      {...props}
      messages={[
        {
          messageId: 'a',
          role: 'assistant',
          blocks: [{ blockId: 'a', blockType: 'text', content }],
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
  fireEvent.click(screen.getByRole('tab', { name: 'References' }));
  expect(screen.getAllByTestId('reference-domain').length).toBeLessThanOrEqual(8);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search references' }), {
    target: { value: 'github' },
  });
  fireEvent.click(screen.getByTestId('reference-domain'));
  fireEvent.click(screen.getByRole('button', { name: /pull\/12/ }));
  expect(screen.getByText('Checks not reported')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
  expect(screen.getByRole('dialog', { name: 'Resources' })).toBeTruthy();
  expect(
    (screen.getByRole('textbox', { name: 'Search references' }) as HTMLInputElement).value,
  ).toBe('github');
  expect(screen.getByRole('tab', { name: 'References' }).getAttribute('aria-selected')).toBe(
    'true',
  );
});
