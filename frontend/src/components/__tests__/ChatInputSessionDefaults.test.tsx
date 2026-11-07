// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
import { useNewChatDraft } from '../../hooks/useNewChatDraft';
import { createChatDraft, getChatDraft } from '../../lib/chat-drafts';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionResourcesDialog', () => ({
  SessionResourcesDialog: ({ selectedContextBlocks }: { selectedContextBlocks: string[] }) => (
    <output data-testid="context-blocks">{JSON.stringify(selectedContextBlocks)}</output>
  ),
}));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

it.each([false, true])(
  'does not resurrect cleared default context when acceptance switches a controlled composer into the assigned session (volatile=%s)',
  (volatile) => {
    const draft = { ...createChatDraft(), contextBlocks: ['Saved default project context'] };
    let accept: (() => void) | undefined;
    const firstSend = vi.fn<Parameters<typeof ChatInput>[0]['onSend']>(
      (_text, _images, context, delivery, assigned) => {
        expect(context).toBeUndefined();
        accept = () => {
          assigned?.('child');
          delivery?.('accepted');
        };
        return true;
      },
    );
    const view = render(
      <ChatInput
        savedChatDraft={draft}
        externalContextBlocks={draft.contextBlocks}
        running={false}
        onStop={() => {}}
        onSend={firstSend}
      />,
    );
    // The ordinary new-chat Defaults action clears the parent-owned context.
    view.rerender(
      <ChatInput
        savedChatDraft={draft}
        externalContextBlocks={[]}
        running={false}
        onStop={() => {}}
        onSend={firstSend}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'First task' } });
    const write = Storage.prototype.setItem;
    const fault = volatile
      ? vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
          this: Storage,
          key,
          value,
        ) {
          if (key.startsWith('mitzo-draft-revision:')) throw Error('Revision unavailable');
          write.call(this, key, value);
        })
      : null;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    if (volatile) expect(firstSend.mock.calls[0][5]).toBeUndefined();
    fault?.mockRestore();
    act(() => accept?.());
    const nextSend = vi.fn((_text: string, _images?: unknown, _context?: string[]) => false);
    view.rerender(
      <ChatInput
        sessionId="child"
        savedChatDraft={draft}
        running={false}
        onStop={() => {}}
        onSend={nextSend}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Next message' } });
    expect(screen.getByTestId('context-blocks').textContent).toBe('[]');
  },
);

it('waits for delayed defaults before mounting the real composer, preserving context in saved and sent input', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const sent = vi.fn((_text: string, _images?: unknown, _context?: string[]) => false);
  let draftId = '';
  function Fixture() {
    const owner = useNewChatDraft(null, 0, true);
    draftId = owner.draft.id;
    return owner.defaultsHydrating ? (
      <p role="status">Loading saved configuration</p>
    ) : (
      <ChatInput savedChatDraft={owner.draft} running={false} onStop={() => {}} onSend={sent} />
    );
  }
  render(<Fixture />);
  expect(screen.queryByLabelText('Message Mitzo')).toBeNull();
  await act(async () =>
    resolve(
      Response.json({
        revision: 2,
        configuration: {
          version: 1,
          runtime: {
            version: 1,
            account: { accountId: 'personal', model: 'luna-fixture' },
            agentProfile: null,
            execution: { location: 'local', targetId: 'mac' },
          },
          mode: 'agent',
          isolation: true,
          repositoryWorkspaceId: null,
          contextBlocks: ['Default project context\nwith handoff notes'],
          extraTools: [],
        },
      }),
    ),
  );
  const input = await screen.findByLabelText('Message Mitzo');
  fireEvent.change(input, { target: { value: 'Start the task' } });
  await waitFor(() =>
    expect(getChatDraft(draftId)?.contextBlocks).toEqual([
      'Default project context\nwith handoff notes',
    ]),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(sent).toHaveBeenCalled();
  expect(sent.mock.calls[0][2]).toEqual(['Default project context\nwith handoff notes']);
});
