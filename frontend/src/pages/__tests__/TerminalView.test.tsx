// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { forwardRef, useImperativeHandle, useEffect } from 'react';
const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => {}),
  review: vi.fn(() => 'private terminal output'),
}));
vi.mock('../../components/TerminalConsole', () => ({
  TerminalConsole: forwardRef(function Mock(props: { onStatus: (state: string) => void }, ref) {
    useImperativeHandle(ref, () => ({
      send: mocks.send,
      reviewOutput: mocks.review,
      focus: vi.fn(),
    }));
    useEffect(() => props.onStatus('connected'), [props.onStatus]);
    return <div>Shell output</div>;
  }),
}));
vi.mock('../../components/AccountModelPicker', () => ({
  AccountModelPicker: function MockPicker({ onChange }: { onChange: (value: unknown) => void }) {
    useEffect(() => onChange(null), [onChange]);
    return (
      <button
        onClick={() => onChange({ accountId: 'work', model: 'luna', reasoningEffort: 'low' })}
      >
        Use Work Luna Low
      </button>
    );
  },
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../lib/api-fetch';
import { TerminalView } from '../TerminalView';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup(path = '/terminal?sessionId=chat-a') {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/advice')
            ? { text: 'Try checking', commands: ['ls -la'] }
            : String(url).includes('/context')
              ? {}
              : {
                  id: 'owned',
                  label: 'This sandbox',
                  kind: 'sandbox',
                  cwd: '/workspace',
                  state: 'running',
                },
        ),
      ),
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TerminalView />
    </MemoryRouter>,
  );
}
it('opens from chat into its own destination, keeps adviser collapsed and returns without ending', async () => {
  const view = setup();
  await screen.findByText('Shell output');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/terminals',
    expect.objectContaining({ body: JSON.stringify({ sessionId: 'chat-a' }) }),
  );
  expect(screen.getByRole('link', { name: 'Back to chat' }).getAttribute('href')).toBe(
    '/chat/chat-a',
  );
  expect(screen.queryByText('Use Work Luna Low')).toBeNull();
  view.unmount();
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/end'))).toBe(false);
});
it('starts directly on the host from More and runs only after deliberate submit', async () => {
  setup('/terminal');
  await screen.findByText('Shell output');
  expect(apiFetch).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ body: '{}' }));
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'pwd' } });
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('pwd\r'));
});
it('reviews output before sharing and stages an adviser suggestion without running it', async () => {
  setup();
  await screen.findByText('Shell output');
  fireEvent.click(screen.getByRole('button', { name: 'Show Minion' }));
  fireEvent.click(screen.getByText('Use Work Luna Low'));
  expect(mocks.review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Share output' }));
  expect(mocks.review).toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/advice'), expect.anything());
  fireEvent.change(screen.getByLabelText('Reviewed output'), { target: { value: 'redacted' } });
  fireEvent.change(screen.getByLabelText('Ask Minion'), { target: { value: 'help' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask adviser' }));
  await screen.findByText('Try checking');
  const call = vi.mocked(apiFetch).mock.calls.find(([url]) => String(url).endsWith('/advice'))!;
  expect(JSON.parse(call[1]!.body as string).output).toBe('redacted');
  fireEvent.click(screen.getByRole('button', { name: 'Use ls -la' }));
  expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('ls -la');
  expect(mocks.send).not.toHaveBeenCalled();
});

it('preserves the adviser selection when its panel and all controls are collapsed', async () => {
  setup();
  await screen.findByText('Shell output');
  fireEvent.click(screen.getByRole('button', { name: 'Show Minion' }));
  fireEvent.click(screen.getByText('Use Work Luna Low'));
  fireEvent.click(screen.getByRole('button', { name: 'Hide Minion' }));
  fireEvent.click(screen.getByRole('button', { name: 'Collapse controls' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show controls' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show Minion' }));
  fireEvent.change(screen.getByLabelText('Ask Minion'), { target: { value: 'help' } });
  expect((screen.getByRole('button', { name: 'Ask adviser' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it('shows every line of a staged adviser command before executing it', async () => {
  setup();
  await screen.findByText('Shell output');
  fireEvent.click(screen.getByRole('button', { name: 'Show Minion' }));
  fireEvent.click(screen.getByText('Use Work Luna Low'));
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ text: 'Two commands', commands: ['printf first\npwd'] })),
  );
  fireEvent.change(screen.getByLabelText('Ask Minion'), { target: { value: 'help' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask adviser' }));
  await screen.findByText('Two commands');
  fireEvent.click(screen.getByRole('button', { name: /Use printf/ }));
  const draft = screen.getByLabelText('Command') as HTMLTextAreaElement;
  expect(draft.tagName).toBe('TEXTAREA');
  expect(draft.value).toBe('printf first\npwd');
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('printf first\npwd\r'));
});

it('retains deliberately reviewed output in subsequent adviser turns', async () => {
  setup();
  await screen.findByText('Shell output');
  fireEvent.click(screen.getByRole('button', { name: 'Show Minion' }));
  fireEvent.click(screen.getByText('Use Work Luna Low'));
  fireEvent.click(screen.getByRole('button', { name: 'Share output' }));
  fireEvent.change(screen.getByLabelText('Reviewed output'), { target: { value: 'redacted' } });
  fireEvent.change(screen.getByLabelText('Ask Minion'), { target: { value: 'help' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask adviser' }));
  await screen.findByText('Try checking');
  fireEvent.change(screen.getByLabelText('Ask Minion'), { target: { value: 'why?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask adviser' }));
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/advice')),
    ).toHaveLength(2),
  );
  const requests = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path]) => String(path).endsWith('/advice'));
  const body = JSON.parse(requests[1][1]!.body as string);
  expect(body.messages[0]).toEqual({
    role: 'user',
    content: 'help\n\nReviewed terminal output:\nredacted',
  });
  expect(body.output).toBeUndefined();
});
