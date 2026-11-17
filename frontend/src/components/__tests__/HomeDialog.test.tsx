import { OrdinaryRuntimeContinuationCommandSchema } from '@mitzo/protocol';
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HomeDialog } from '../HomeDialog';
import { useState } from 'react';
import { useLocalCommandRecovery } from '../LocalCommandRecovery';
import { localFirstCommandFixture } from '../../../../packages/client/src/__tests__/fixtures/local-first-command';

function claudeRecoveryCommand(id: string) {
  return {
    state: 'uncertain',
    request: OrdinaryRuntimeContinuationCommandSchema.parse({
      ...localFirstCommandFixture,
      clientMsgId: id,
      sessionId: id,
      runtime: {
        ...localFirstCommandFixture.runtime,
        harness: 'claude-sdk',
        account: { ...localFirstCommandFixture.runtime.account, provider: 'anthropic-claude' },
      },
    }),
  };
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

it('reviews delivery without sending and preserves the mounted draft through refused withdrawal', async () => {
  const recover = vi.fn(() => true),
    withdraw = vi.fn(async () => false),
    refresh = vi.fn();
  const command = claudeRecoveryCommand('old-chat');
  function Host() {
    const recovery = useLocalCommandRecovery({
      command,
      connected: true,
      recover,
      withdraw,
      refresh,
      scope: 'old-chat',
    });
    return (
      <>
        <textarea aria-label="Retained draft" defaultValue="Keep my edits" />
        <button onClick={recovery.action.onClick}>{recovery.action.label}</button>
        {recovery.dialog}
      </>
    );
  }
  render(<Host />);
  const input = screen.getByRole('textbox');
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review delivery' }));
  expect(recover).not.toHaveBeenCalled();
  expect(withdraw).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw and review' }));
  await screen.findByText(
    'Withdrawal is unconfirmed. Keep this draft and check the original message.',
  );
  expect(withdraw).toHaveBeenCalledWith(command.request.clientMsgId);
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe('Keep my edits');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { hidden: true })).not.toBeNull();
});

it.each([true, false])(
  'fences a departed withdrawal completion (new review=%s)',
  async (newReview) => {
    let finish!: (value: boolean) => void;
    const withdraw = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = vi.fn();
    function Host({ id }: { id: string }) {
      const command = claudeRecoveryCommand(id);
      const recovery = useLocalCommandRecovery({
        command,
        connected: true,
        recover: () => true,
        withdraw,
        refresh,
        scope: id,
      });
      return (
        <>
          <button onClick={recovery.action.onClick}>{recovery.action.label}</button>
          {recovery.dialog}
        </>
      );
    }
    const view = render(<Host id="first" />);
    fireEvent.click(screen.getByRole('button', { name: 'Review delivery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw and review' }));
    view.rerender(<Host id="second" />);
    if (newReview) fireEvent.click(screen.getByRole('button', { name: 'Review delivery' }));
    await act(async () => finish(newReview));
    if (!newReview) view.rerender(<Host id="first" />);
    expect(screen.getByRole('dialog', { name: 'Message delivery' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Withdraw and review' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  },
);

it('opens the shared sheet once without replaying on edits or retaining motion after close', () => {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name.includes('duration') ? '200ms' : 'ease-out'),
  }));
  const view = render(
    <HomeDialog title="Review" onClose={() => {}}>
      <input aria-label="Retained draft" defaultValue="Original" />
    </HomeDialog>,
  );
  const draft = screen.getByRole('textbox');
  fireEvent.change(draft, { target: { value: 'Edited draft' } });
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender(
    <HomeDialog title="Review updated" onClose={() => {}}>
      <input aria-label="Retained draft" defaultValue="Original" />
    </HomeDialog>,
  );
  expect(screen.getByRole('textbox')).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe('Edited draft');
  expect(animate).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('supports a shared full-screen variant while retaining native close, focus and scroll ownership', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const parentKey = vi.fn();
  const close = vi.fn();
  const view = render(
    <div onKeyDown={parentKey}>
      <HomeDialog title="Preview" className="fullscreen-test" onClose={close}>
        <button>Draw</button>
      </HomeDialog>
    </div>,
  );
  const dialog = screen.getByRole('dialog');
  expect(dialog.classList.contains('home-dialog')).toBe(true);
  expect(dialog.classList.contains('fullscreen-test')).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Draw' }), { key: 'Enter' });
  expect(parentKey).not.toHaveBeenCalled();
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.body.style.overflow).toBe('');
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it('makes a retained closing surface inert and hidden from assistive technology', () => {
  render(
    <HomeDialog title="File options" inactive onClose={() => {}}>
      <button>Share</button>
    </HomeDialog>,
  );
  const dialog = screen.getByRole('dialog', { hidden: true });
  expect(dialog.hasAttribute('inert')).toBe(true);
  expect(dialog.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
});

it('keeps nested cancellation inside its form, including a busy dismissal guard', () => {
  const outerClose = vi.fn();
  const innerClose = vi.fn();
  const view = render(
    <HomeDialog title="Selected work" onClose={outerClose}>
      <HomeDialog title="Add contributor" onClose={innerClose}>
        <input aria-label="Contributor name" />
      </HomeDialog>
    </HomeDialog>,
  );
  fireEvent(
    screen.getByRole('dialog', { name: 'Add contributor' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(innerClose).toHaveBeenCalledOnce();
  expect(outerClose).not.toHaveBeenCalled();
  view.rerender(
    <HomeDialog title="Selected work" onClose={outerClose}>
      <HomeDialog title="Add contributor" onClose={() => {}}>
        <input aria-label="Contributor name" />
      </HomeDialog>
    </HomeDialog>,
  );
  const cancel = new Event('cancel', { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('dialog', { name: 'Add contributor' }), cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(outerClose).not.toHaveBeenCalled();
  expect(screen.getAllByRole('dialog')).toHaveLength(2);
});

it('restores the original scroll state when a nested view unmounts together', () => {
  document.body.style.overflow = 'auto';
  function View() {
    const [nested, setNested] = useState(false);
    return (
      <HomeDialog title="Selected work" onClose={() => {}}>
        <button onClick={() => setNested(true)}>Keep output</button>
        {nested && (
          <HomeDialog title="Keep output" onClose={() => {}}>
            Draft
          </HomeDialog>
        )}
      </HomeDialog>
    );
  }
  const view = render(<View />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep output' }));
  expect(document.body.style.overflow).toBe('hidden');
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
  document.body.style.overflow = '';
});

it('keeps scrolling locked until the last sibling or nested owner closes', () => {
  function View() {
    const [outer, setOuter] = useState(true);
    return (
      <>
        {outer && (
          <HomeDialog title="First" onClose={() => setOuter(false)}>
            First
          </HomeDialog>
        )}
        <HomeDialog title="Second" onClose={() => {}}>
          Second
        </HomeDialog>
      </>
    );
  }
  const view = render(<View />);
  fireEvent(
    screen.getByRole('dialog', { name: 'First' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(document.body.style.overflow).toBe('hidden');
  view.unmount();
  expect(document.body.style.overflow).toBe('');
});

it('can retain editable content while closed without keeping the modal or scroll lock active', () => {
  const onClose = vi.fn();
  const view = render(
    <HomeDialog title="Saved setup" open={false} onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  view.rerender(
    <HomeDialog title="Saved setup" open onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  const field = screen.getByRole('textbox', { name: 'Setup guidance' });
  fireEvent.change(field, { target: { value: 'Edited guidance' } });
  view.rerender(
    <HomeDialog title="Saved setup" open={false} onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  view.rerender(
    <HomeDialog title="Saved setup" open onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  expect(screen.getByRole('textbox', { name: 'Setup guidance' })).toBe(field);
  expect((field as HTMLInputElement).value).toBe('Edited guidance');
});

it('restores focus beyond a concealed settings editor when its summary is concealed too', () => {
  const outer = document.createElement('div');
  outer.innerHTML =
    '<button aria-controls="outer-settings">Settings</button><div id="outer-settings"><button aria-controls="field-editor">More options</button><div id="field-editor"><button>Review findings</button></div></div>';
  document.body.append(outer);
  const buttons = outer.querySelectorAll('button');
  buttons[2].focus();
  const view = render(
    <HomeDialog title="Review" onClose={() => {}}>
      Details
    </HomeDialog>,
  );
  outer.querySelector('#outer-settings')!.setAttribute('inert', '');
  outer.querySelector('#field-editor')!.setAttribute('hidden', '');
  view.unmount();
  expect(document.activeElement).toBe(buttons[0]);
  outer.remove();
});

it('offers Retry for a failed early start but not while it is still preparing', () => {
  const recover = vi.fn(() => true);
  function Host({ state }: { state: string }) {
    const recovery = useLocalCommandRecovery({
      command: { state, request: localFirstCommandFixture } as never,
      connected: true,
      recover,
      withdraw: vi.fn(async () => false),
      refresh: vi.fn(),
      scope: 'new-chat',
    });
    return (
      <button disabled={recovery.action.disabled} onClick={recovery.action.onClick}>
        {recovery.action.label}
      </button>
    );
  }
  const { rerender } = render(<Host state="preparing" />);
  expect(screen.getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', true);
  rerender(<Host state="retained" />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(recover).toHaveBeenCalledOnce();
});
