// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import { createTelosLifecycleFixture } from '../../test-utils/telos-lifecycle-fixtures';
import { TelosItemLifecycle } from '../TelosItemLifecycle';
const auth = vi.hoisted(() => ({ id: 'fixture-operator', base: '' }));
vi.mock('../../lib/api-fetch', async (load) => ({
  ...(await load<typeof import('../../lib/api-fetch')>()),
  currentVerifiedAuthSessionId: () => auth.id || undefined,
  getApiBaseUrl: () => auth.base,
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: () => () => {}, onConnectionChange: () => () => {} },
}));
let view: ReturnType<typeof createTelosLifecycleFixture>;
const props = {
  itemId: 'selected',
  title: 'Retain the original outcome and its saved work',
  kind: 'outcome' as const,
  refreshKey: 0,
  onOpen: vi.fn(),
  onDeleted: vi.fn(),
  onCurrentState: vi.fn(),
};
beforeEach(() => {
  auth.id = 'fixture-operator';
  sessionStorage.clear();
  view = createTelosLifecycleFixture();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockImplementation(async () =>
    structuredClone(view),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  sessionStorage.clear();
});
async function actions() {
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Item actions' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Item actions' }));
}
it('makes no lifecycle write on mount and keeps requested pause distinct from applied evidence', async () => {
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockImplementation(async (command) => {
      view = createTelosLifecycleFixture('requested');
      return {
        requestId: command.requestId,
        itemId: command.itemId,
        operation: command.operation,
        lifecycle: view,
      };
    });
  render(<TelosItemLifecycle {...props} />);
  await screen.findByText('No operator pause');
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await screen.findByText('Pause requested');
  expect(screen.queryByText('Pause applied')).toBeNull();
  expect(write.mock.calls[0][0]).toMatchObject({
    itemId: 'selected',
    expectedRevision: 'a'.repeat(64),
    operation: 'pause',
  });
  expect(write.mock.calls[0][0]).not.toHaveProperty('actorId');
  expect(write.mock.calls[0][0]).not.toHaveProperty('acknowledgement');
});
it('resumes the selected operator pause without claiming independent holds are released', async () => {
  view = createTelosLifecycleFixture('acknowledged');
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockImplementation(async (command) => {
      view = createTelosLifecycleFixture();
      return {
        requestId: command.requestId,
        itemId: command.itemId,
        operation: command.operation,
        lifecycle: view,
      };
    });
  render(<TelosItemLifecycle {...props} />);
  await screen.findByText('Pause acknowledged · application pending');
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await screen.findByText('No operator pause');
  expect(write.mock.calls[0][0].operation).toBe('resume');
  expect(screen.getByText('Other holds may still apply.')).toBeTruthy();
});
it('moves to recoverable Trash only after review, then restores the actual pre-trash archive state', async () => {
  view = createTelosLifecycleFixture('running', 'archived');
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockImplementation(async (command) => {
      view = createTelosLifecycleFixture(
        'running',
        command.operation === 'trash' ? 'trashed' : 'archived',
      );
      return {
        requestId: command.requestId,
        itemId: command.itemId,
        operation: command.operation,
        lifecycle: view,
      };
    });
  render(<TelosItemLifecycle {...props} />);
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
  const dialog = screen.getByRole('dialog', { name: 'Move item to Trash?' });
  expect(write).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain('restore');
  expect(dialog.textContent).toContain('Saved files');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
  await screen.findByText('In Trash');
  expect(write.mock.calls[0][0].operation).toBe('trash');
  expect(write.mock.calls[0][0]).not.toHaveProperty('confirmation');
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
  await screen.findByText('Archived');
  expect(write.mock.calls.map(([command]) => command.operation)).toEqual(['trash', 'restore']);
  expect(props.onDeleted).not.toHaveBeenCalled();
});
it('offers a separate exact deletion confirmation and preserves a real host refusal without deletion success', async () => {
  view = createTelosLifecycleFixture('running', 'trashed');
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockRejectedValue(
      new TelosWorkApiError(
        409,
        'conflict',
        'Verified host quiescence required for permanent deletion',
      ),
    );
  render(<TelosItemLifecycle {...props} />);
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete item permanently?' });
  expect(within(dialog).getByText(props.title)).toBeTruthy();
  expect(within(dialog).getByText('selected')).toBeTruthy();
  const confirm = within(dialog).getByRole('button', {
    name: 'Delete permanently',
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(
    within(dialog).getByRole('textbox', { name: 'Type DELETE PERMANENTLY to confirm' }),
    { target: { value: 'delete permanently' } },
  );
  expect(confirm.disabled).toBe(true);
  expect(write).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'DELETE PERMANENTLY' },
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'Verified host quiescence required',
    ),
  );
  expect(write.mock.calls[0][0]).toMatchObject({
    operation: 'delete_permanently',
    confirmation: { itemId: 'selected', phrase: 'DELETE PERMANENTLY' },
  });
  const refusal = within(dialog).getByRole('alert');
  expect(
    within(refusal).getByText(
      'Permanent deletion is unavailable because this server cannot verify that it is safe. This request did not delete the item.',
    ),
  ).toBeTruthy();
  const details = refusal.querySelector('details')!;
  expect(details.hasAttribute('open')).toBe(false);
  expect(within(details).getByText('HTTP 409 · conflict')).toBeTruthy();
  expect(details.textContent).toContain('Verified host quiescence required for permanent deletion');
  expect(props.onDeleted).not.toHaveBeenCalled();
  expect(screen.queryByText('Item permanently deleted.')).toBeNull();
});
it('does not delete on cancellation and only reports deletion after a validated null lifecycle receipt', async () => {
  view = createTelosLifecycleFixture('running', 'trashed');
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockImplementation(async (command) => ({
      requestId: command.requestId,
      itemId: command.itemId,
      operation: command.operation,
      lifecycle: null,
    }));
  render(<TelosItemLifecycle {...props} />);
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(write).not.toHaveBeenCalled();
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'DELETE PERMANENTLY' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(props.onDeleted).toHaveBeenCalledOnce());
  expect(write).toHaveBeenCalledTimes(1);
});
it('keeps inherited visibility and pause attached to the actual containing item without offering a false local restore or resume', async () => {
  const parent = createTelosLifecycleFixture('requested', 'trashed', 'parent');
  view = {
    ...createTelosLifecycleFixture(),
    effectiveDisposition: 'trashed',
    inheritedFrom: 'parent',
    pause: parent.pause,
  };
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  render(<TelosItemLifecycle {...props} kind="work_item" parentId="parent" />);
  await screen.findByText('Hidden with containing item');
  fireEvent.click(screen.getByRole('button', { name: 'Open containing item' }));
  expect(props.onOpen).toHaveBeenCalledWith('parent');
  await actions();
  expect(screen.queryByRole('menuitem', { name: 'Restore' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Delete permanently' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  expect(write).not.toHaveBeenCalled();
});
it('keeps an uncertain operation for explicit identical retry instead of allowing a new request', async () => {
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockRejectedValue(new TypeError('connection lost'));
  render(<TelosItemLifecycle {...props} />);
  await screen.findByText('No operator pause');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await screen.findByRole('button', { name: 'Retry original request' });
  const original = structuredClone(write.mock.calls[0][0]);
  write.mockImplementation(async (command) => {
    view = createTelosLifecycleFixture('requested');
    return {
      requestId: command.requestId,
      itemId: command.itemId,
      operation: command.operation,
      lifecycle: view,
    };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
  await screen.findByText('Pause requested');
  expect(write.mock.calls[1][0]).toEqual(original);
  expect(write).toHaveBeenCalledTimes(2);
});
it('does not silently authorize controls when the current lifecycle read is unavailable', async () => {
  vi.mocked(TelosWorkApiClient.prototype.readLifecycle).mockRejectedValue(
    new TelosWorkApiError(403, 'unauthorized', 'Current interactive operator required'),
  );
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  render(<TelosItemLifecycle {...props} />);
  await screen.findByText(/Current interactive operator required/);
  expect(screen.getByRole('button', { name: 'Refresh item controls' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Item actions' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(write).not.toHaveBeenCalled();
});
it('requires a new review when the lifecycle revision changes while a destructive dialog is open', async () => {
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  const mounted = render(<TelosItemLifecycle {...props} />);
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
  view = { ...view, revision: 'b'.repeat(64) };
  mounted.rerender(<TelosItemLifecycle {...props} refreshKey={1} />);
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByText(
    'This item changed. Close and review its current state before confirming.',
  );
  const confirm = within(dialog).getByRole('button', {
    name: 'Move to Trash',
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(write).not.toHaveBeenCalled();
});
it('reconfirms an uncertain deletion and retries only its exact original request even when the item read is now unavailable', async () => {
  view = createTelosLifecycleFixture('running', 'trashed');
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockRejectedValue(new TypeError('receipt connection lost'));
  render(<TelosItemLifecycle {...props} />);
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  let dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'DELETE PERMANENTLY' },
  });
  vi.mocked(TelosWorkApiClient.prototype.readLifecycle).mockRejectedValue(
    new TelosWorkApiError(404, 'not_found', 'Current item unavailable'),
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  await within(dialog).findByRole('alert');
  const original = structuredClone(write.mock.calls[0][0]);
  expect(props.onDeleted).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
  dialog = screen.getByRole('dialog');
  expect((within(dialog).getByRole('textbox') as HTMLInputElement).value).toBe('');
  const confirm = within(dialog).getByRole('button', {
    name: 'Delete permanently',
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  write.mockImplementation(async (command) => ({
    requestId: command.requestId,
    itemId: command.itemId,
    operation: command.operation,
    lifecycle: null,
  }));
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'DELETE PERMANENTLY' },
  });
  fireEvent.click(confirm);
  await waitFor(() => expect(props.onDeleted).toHaveBeenCalledOnce());
  expect(write.mock.calls[1][0]).toEqual(original);
});
it('closes a destructive review on an authentication change and requires a fresh confirmation in the new login', async () => {
  view = createTelosLifecycleFixture('running', 'trashed');
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  render(<TelosItemLifecycle {...props} />);
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox'), {
    target: { value: 'DELETE PERMANENTLY' },
  });
  auth.id = '';
  fireEvent(window, new Event('mitzo:auth-lost'));
  expect(screen.queryByRole('dialog')).toBeNull();
  auth.id = 'other-operator';
  fireEvent(window, new Event('mitzo:auth-restored'));
  await actions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
  const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByRole('textbox') as HTMLInputElement).value).toBe('');
  expect(
    (within(dialog).getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(write).not.toHaveBeenCalled();
});
it('keeps current-state review required when a refused operation is reopened, before offering its identical retry', async () => {
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockRejectedValue(new TelosWorkApiError(409, 'conflict', 'Refused lifecycle request'));
  const first = render(<TelosItemLifecycle {...props} />);
  await screen.findByText('No operator pause');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await screen.findByRole('button', { name: 'Review current state' });
  const original = structuredClone(write.mock.calls[0][0]);
  first.unmount();
  render(<TelosItemLifecycle {...props} />);
  const review = await screen.findByRole('button', { name: 'Review current state' });
  expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull();
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  expect(write).toHaveBeenCalledTimes(1);
  fireEvent.click(review);
  expect(write).toHaveBeenCalledTimes(1);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original request' }));
  await screen.findByRole('button', { name: 'Review current state' });
  expect(write.mock.calls[1][0]).toEqual(original);
  expect(write).toHaveBeenCalledTimes(2);
});
