// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SymposiumProvenance } from '@mitzo/protocol';
import {
  OutputContributorPanel,
  type OutputContributorPanelProps,
} from '../OutputContributorPanel';
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: (props: {
    scope: string;
    sessionId: null;
    draftOnly: boolean;
    requireExplicitSelection: boolean;
    onChange: (selection: unknown) => void;
  }) => {
    expect(props.scope).toBe('chat');
    expect(props.sessionId).toBeNull();
    expect(props.draftOnly && props.requireExplicitSelection).toBe(true);
    return (
      <button
        onClick={() => props.onChange({ accountId: 'ordinary-account', model: 'luna-fixture' })}
      >
        Use ordinary account
      </button>
    );
  },
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: (props: {
    updateSearchParams: boolean;
    onChange: (selection: unknown, reason?: string) => void;
  }) => {
    expect(props.updateSearchParams).toBe(false);
    return (
      <>
        <span>Optional Library guidance</span>
        <button onClick={() => props.onChange(null, 'Optional Library unavailable')}>
          Library unavailable
        </button>
      </>
    );
  },
}));
vi.mock('../HomeDialog', () => ({
  HomeDialog: (props: { title: string; onClose: () => void; children: React.ReactNode }) => (
    <div role="dialog" aria-label={props.title}>
      <button onClick={props.onClose}>Close</button>
      {props.children}
    </div>
  ),
}));
vi.mock('../MessageBubble', () => ({
  TextBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));
afterEach(cleanup);
const source = { messageId: 'answer', blockId: 'draft', messageEndSeq: 4, sha256: 'a'.repeat(64) };
const output = {
  outputId: 'output-1',
  sessionId: 'source-chat',
  title: 'Decision draft',
  revision: 1 as const,
  kind: 'inline_draft' as const,
  durability: 'reference_registered' as const,
  label: 'In conversation' as const,
  sourceAvailability: 'available' as const,
  source: { sessionId: 'source-chat', ...source },
  provenance: null,
  createdAt: 1,
};
function props(overrides: Partial<OutputContributorPanelProps> = {}): OutputContributorPanelProps {
  return {
    sessionId: 'source-chat',
    candidates: [],
    outputs: [],
    selected: null,
    contributors: [],
    eligibility: { available: true, reason: 'Supported ordinary route' },
    onRegister: vi.fn(async () => {}),
    onSelect: vi.fn(),
    onAdd: vi.fn(async () => {}),
    onSend: vi.fn(async () => {}),
    onStop: vi.fn(async () => {}),
    onRefresh: vi.fn(),
    ...overrides,
  };
}
function mount(value: OutputContributorPanelProps) {
  return render(
    <MemoryRouter>
      <OutputContributorPanel {...value} />
    </MemoryRouter>,
  );
}
it('leaves empty ordinary chat free of output or contributor setup', () => {
  const value = props();
  mount(value);
  expect(screen.queryByRole('region', { name: 'Outputs' })).toBeNull();
  expect(value.onRegister).not.toHaveBeenCalled();
  expect(value.onAdd).not.toHaveBeenCalled();
});
it('offers an already registered exact draft through its output instead of another registration', () => {
  mount(
    props({
      outputs: [output],
      candidates: [{ source, content: 'Registered draft' }],
      selected: { output, content: 'Registered draft', contextPackageDigest: 'b'.repeat(64) },
    }),
  );
  expect(screen.queryByRole('button', { name: 'Keep as output' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add contributor' })).toBeTruthy();
});
it('registers only the explicitly selected finalized block and preserves its exact descriptor', async () => {
  const value = props({ candidates: [{ source, content: 'Exact selected draft' }] });
  mount(value);
  fireEvent.click(screen.getByRole('button', { name: 'Keep as output' }));
  fireEvent.change(screen.getByLabelText('Output title'), { target: { value: 'Decision draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep selected draft' }));
  await waitFor(() =>
    expect(value.onRegister).toHaveBeenCalledWith(
      { source, content: 'Exact selected draft' },
      'Decision draft',
    ),
  );
});
it('does not replace a draft being inspected when new finalized blocks arrive', async () => {
  const original = { source, content: 'The selected draft' };
  const value = props({ candidates: [original] });
  const view = mount(value);
  fireEvent.click(screen.getByRole('button', { name: 'Keep as output' }));
  view.rerender(
    <MemoryRouter>
      <OutputContributorPanel
        {...value}
        candidates={[
          { source: { ...source, blockId: 'new-draft' }, content: 'Newer draft' },
          original,
        ]}
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Output title'), { target: { value: 'Selected draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep selected draft' }));
  await waitFor(() => expect(value.onRegister).toHaveBeenCalledWith(original, 'Selected draft'));
});
it('binds a new contributor to the output revision, context and explicitly selected ordinary account', async () => {
  const value = props({
    outputs: [output],
    selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
  });
  mount(value);
  expect(screen.getByText(/depends on this conversation/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add contributor' }));
  const add = screen.getByRole('button', { name: 'Add to this output' });
  expect(add.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Contributor name'), { target: { value: 'Joe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use ordinary account' }));
  fireEvent.change(screen.getByLabelText('Additional guidance'), {
    target: { value: 'Challenge assumptions' },
  });
  fireEvent.click(add);
  await waitFor(() =>
    expect(value.onAdd).toHaveBeenCalledWith({
      label: 'Joe',
      accountId: 'ordinary-account',
      model: 'luna-fixture',
      instructions: 'Challenge assumptions',
      mode: 'ask',
      outputId: 'output-1',
      outputRevision: 1,
      contextPackageDigest: 'b'.repeat(64),
    }),
  );
});
it('allows ordinary guidance when the optional Library is unavailable', async () => {
  const value = props({
    outputs: [output],
    selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
  });
  mount(value);
  fireEvent.click(screen.getByRole('button', { name: 'Add contributor' }));
  fireEvent.change(screen.getByLabelText('Contributor name'), { target: { value: 'Joe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use ordinary account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Library unavailable' }));
  expect(screen.getByRole('button', { name: 'Add to this output' }).hasAttribute('disabled')).toBe(
    false,
  );
});
it('keeps an open contributor draft after access becomes unavailable while disabling submission', () => {
  const value = props({
    outputs: [output],
    selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
  });
  const view = mount(value);
  fireEvent.click(screen.getByRole('button', { name: 'Add contributor' }));
  fireEvent.change(screen.getByLabelText('Contributor name'), { target: { value: 'Joe' } });
  fireEvent.change(screen.getByLabelText('Additional guidance'), {
    target: { value: 'Keep these assumptions' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use ordinary account' }));
  view.rerender(
    <MemoryRouter>
      <OutputContributorPanel
        {...value}
        eligibility={{ available: false, reason: 'Access changed' }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByLabelText('Contributor name')).toHaveProperty('value', 'Joe');
  expect(screen.getByLabelText('Additional guidance')).toHaveProperty(
    'value',
    'Keep these assumptions',
  );
  expect(screen.getByRole('button', { name: 'Add to this output' }).hasAttribute('disabled')).toBe(
    true,
  );
});
it.each([false, null])(
  'disables unverified execution (%s) while explaining eligibility',
  (available) => {
    mount(
      props({
        outputs: [output],
        selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
        eligibility: { available, reason: 'Cancellation proof is unavailable' },
      }),
    );
    expect(screen.getByText('Cancellation proof is unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add contributor' }).hasAttribute('disabled')).toBe(
      true,
    );
  },
);
it('retains a directed draft when send fails and targets Stop to the same contributor', async () => {
  const value = props({
    outputs: [output],
    selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
    contributors: [
      {
        id: 'joe',
        label: 'Joe',
        accountLabel: 'Ordinary account',
        model: 'luna-fixture',
        sessionId: 'child-chat',
        status: 'idle',
        outputId: 'output-1',
        outputRevision: 1,
      },
    ],
    onSend: vi.fn(async () => {
      throw Error('Send not accepted');
    }),
  });
  const view = mount(value);
  fireEvent.change(screen.getByLabelText('Message to Joe'), {
    target: { value: 'Check this draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Joe' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Message to Joe')).toHaveProperty('value', 'Check this draft');
  expect(value.onSend).toHaveBeenCalledWith('joe', 'Check this draft');
  view.rerender(
    <MemoryRouter>
      <OutputContributorPanel
        {...value}
        contributors={value.contributors.map((contributor) => ({
          ...contributor,
          status: 'running',
        }))}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stop Joe' }));
  await waitFor(() => expect(value.onStop).toHaveBeenCalledWith('joe'));
});
it('keeps Stop available after access fails without allowing another send', async () => {
  const value = props({
    outputs: [output],
    selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
    contributors: [
      {
        id: 'joe',
        label: 'Joe',
        accountLabel: 'Ordinary account',
        model: 'luna-fixture',
        sessionId: 'child-chat',
        status: 'running',
        outputId: 'output-1',
        outputRevision: 1,
      },
    ],
    eligibility: { available: false, reason: 'Account unavailable' },
  });
  mount(value);
  fireEvent.change(screen.getByLabelText('Message to Joe'), { target: { value: 'Follow-up' } });
  expect(screen.getByRole('button', { name: 'Send to Joe' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Stop Joe' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Stop Joe' }));
  await waitFor(() => expect(value.onStop).toHaveBeenCalledWith('joe'));
});
it('retains the next directed draft while a contributor is running and offers Stop', () => {
  mount(
    props({
      outputs: [output],
      selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
      contributors: [
        {
          id: 'joe',
          label: 'Joe',
          accountLabel: 'Ordinary account',
          model: 'luna-fixture',
          sessionId: 'child-chat',
          status: 'running',
          outputId: 'output-1',
          outputRevision: 1,
        },
      ],
    }),
  );
  fireEvent.change(screen.getByLabelText('Message to Joe'), { target: { value: 'Next turn' } });
  expect(screen.getByRole('button', { name: 'Send to Joe' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Stop Joe' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByText(/Wait for this contributor/)).toBeTruthy();
});
it('renders inline rich reply text with its recorded account and model attribution', () => {
  const provenance = {
    version: 2,
    seatLabel: 'Joe at review time',
    accountBinding: { accountLabel: 'Original account', model: 'original-model' },
  } as SymposiumProvenance;
  mount(
    props({
      outputs: [output],
      selected: { output, content: 'Pinned draft', contextPackageDigest: 'b'.repeat(64) },
      contributors: [
        {
          id: 'joe',
          label: 'Joe',
          accountLabel: 'Current account',
          model: 'current-model',
          sessionId: 'child-chat',
          status: 'idle',
          outputId: 'output-1',
          outputRevision: 1,
          messages: [
            {
              messageId: 'reply',
              role: 'assistant',
              startedSeq: 8,
              symposiumProvenance: provenance,
              blocks: [
                {
                  blockId: 'reply-text',
                  blockType: 'text',
                  content: '## Attributed review\n\nThe constraint is sound.',
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(screen.getByText('Joe at review time · Original account · original-model')).toBeTruthy();
  expect(screen.getByText(/Attributed review/)).toBeTruthy();
});
