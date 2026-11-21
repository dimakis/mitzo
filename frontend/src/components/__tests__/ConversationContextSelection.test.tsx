// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FinishedMessage } from '@mitzo/protocol';
import {
  ConversationContextSelection,
  type ConversationContextSelectionProps,
} from '../ConversationContextSelection';
import { contextMessagePresentation } from '../../lib/conversation-context-selection';

afterEach(cleanup);
const message = (
  id: string,
  text: string,
  extra: Partial<FinishedMessage> = {},
): FinishedMessage => ({
  messageId: id,
  role: 'assistant',
  blocks: [{ blockId: `${id}:text`, blockType: 'text', content: text }],
  ...extra,
});
const messages = [
  message('human', 'Investigate the parser.', { role: 'user', timestamp: 1_800_000_000_000 }),
  message(
    'answer',
    '# Findings\n\n**Exact** source text and `/workspace/report.md`.\n\n![private image](https://example.test/private.png)\n\n<script>alert(1)</script>\n\n[Local report](/workspace/report.md)',
  ),
  message('progress', 'Checking the parser.', { timestamp: 1_800_000_001_000 }),
];
const metadata = {
  answer: { authorId: 'reviewer', authorLabel: 'Astra reviewer', type: 'reply' as const },
  progress: { authorId: 'reviewer', authorLabel: 'Astra reviewer', type: 'progress' as const },
};
const artifact = {
  artifactId: 'report',
  revision: 2,
  sha256: 'a'.repeat(64),
  title: 'Review report',
  filename: 'report.md',
  available: true,
};

function Harness({
  onMessagesChange = vi.fn(),
  onArtifactsChange = vi.fn(),
  ...props
}: Partial<ConversationContextSelectionProps>) {
  const [ids, setIds] = useState(props.messageIds ?? []);
  const [pins, setPins] = useState(props.selectedArtifacts ?? []);
  return (
    <ConversationContextSelection
      messages={messages}
      artifacts={[artifact]}
      messageMetadata={metadata}
      {...props}
      messageIds={ids}
      selectedArtifacts={pins}
      onMessagesChange={(next) => {
        setIds(next);
        onMessagesChange(next);
      }}
      onArtifactsChange={(next) => {
        setPins(next);
        onArtifactsChange(next);
      }}
    />
  );
}

it('keeps exact selection while search, author filters and selected review change only visibility', () => {
  const changed = vi.fn();
  render(<Harness onMessagesChange={changed} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /You Message.*Investigate/ }));
  expect(changed).toHaveBeenLastCalledWith(['human']);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
    target: { value: 'Findings' },
  });
  expect(screen.getByRole('status').textContent).toContain('1 selected messages hidden by filters');
  fireEvent.click(screen.getByRole('checkbox', { name: /Astra reviewer Reply/ }));
  expect(changed).toHaveBeenLastCalledWith(['human', 'answer']);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Author' }), {
    target: { value: 'reviewer' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Review selected only' }));
  expect(screen.queryByText(/Progress \(/)).toBeNull();
  expect(changed).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
  expect((screen.getByRole('checkbox', { name: /You Message/ }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(
    (screen.getByRole('checkbox', { name: /Astra reviewer Reply/ }) as HTMLInputElement).checked,
  ).toBe(true);
});

it('expands formatted text safely and returns focus with Escape without selecting or loading references', async () => {
  const changed = vi.fn();
  const view = render(<Harness onMessagesChange={changed} />);
  const preview = within(
    screen.getByRole('checkbox', { name: /Astra reviewer Reply/ }).closest('article')!,
  ).getByText('Preview message from Astra reviewer', { selector: 'summary' });
  expect(screen.queryByRole('heading', { name: 'Findings' })).toBeNull();
  expect(view.container.querySelector('.context-source-preview')).toBeNull();
  fireEvent.click(preview);
  const heading = await screen.findByRole('heading', { name: 'Findings' });
  expect(within(heading.closest('.context-source-preview')!).getByText('Exact').tagName).toBe(
    'STRONG',
  );
  expect(screen.getByText('Image reference: private image (not loaded)')).toBeTruthy();
  expect(view.container.querySelector('img, script, iframe')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Local report' })).toBeNull();
  preview.focus();
  fireEvent.keyDown(heading, { key: 'Escape' });
  expect(document.activeElement).toBe(preview);
  expect(preview.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('heading', { name: 'Findings' })).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it('keeps progress collapsed until requested and retains selection after keyboard dismissal', () => {
  const changed = vi.fn();
  render(<Harness messageIds={['progress']} onMessagesChange={changed} />);
  const disclosure = screen.getByText('Progress (1) · 1 selected');
  expect(screen.queryByRole('checkbox', { name: /Astra reviewer Progress/ })).toBeNull();
  fireEvent.click(disclosure);
  const checkbox = screen.getByRole('checkbox', {
    name: /Astra reviewer Progress/,
  }) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  checkbox.focus();
  fireEvent.keyDown(checkbox, { key: 'Escape' });
  expect(document.activeElement).toBe(disclosure);
  expect(screen.queryByRole('checkbox', { name: /Astra reviewer Progress/ })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('1 messages');
  expect(changed).not.toHaveBeenCalled();
});

it('retains missing message and exact artifact pins across catalog refresh until explicitly removed', () => {
  const changed = vi.fn();
  const artifactsChanged = vi.fn();
  const oldPin = {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    sha256: 'b'.repeat(64),
  };
  const props = {
    messageIds: ['missing'],
    selectedArtifacts: [oldPin],
    onMessagesChange: changed,
    onArtifactsChange: artifactsChanged,
  };
  const view = render(<Harness {...props} />);
  expect(screen.getByRole('status').textContent).toContain('2 selections unavailable');
  expect(
    (screen.getByRole('checkbox', { name: /Review report/ }) as HTMLInputElement).checked,
  ).toBe(false);
  view.rerender(<Harness {...props} artifacts={undefined} messages={[]} />);
  expect(changed).not.toHaveBeenCalled();
  expect(artifactsChanged).not.toHaveBeenCalled();
  expect(screen.getByText(/Retained artifact versions are unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable message missing' }));
  expect(changed).toHaveBeenLastCalledWith([]);
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove unavailable artifact report version 2' }),
  );
  expect(artifactsChanged).toHaveBeenLastCalledWith([]);
});

it('selects only the exact retained revision/hash, shows missing author/access and disables unavailable new selection', () => {
  const changed = vi.fn();
  render(
    <Harness
      onArtifactsChange={changed}
      artifacts={[artifact, { ...artifact, revision: 3, available: false }]}
    />,
  );
  const version2 = screen.getByRole('checkbox', { name: /Review report.*Saved version 2/ });
  const version3 = screen.getByRole('checkbox', {
    name: /Review report.*Saved version 3/,
  }) as HTMLInputElement;
  expect(version3.disabled).toBe(true);
  fireEvent.click(version2);
  expect(changed).toHaveBeenLastCalledWith([
    { artifactId: 'report', revision: 2, sha256: artifact.sha256 },
  ]);
  expect(screen.getAllByText(/Author: not recorded/)).toHaveLength(2);
  expect(screen.getAllByText(/Access: not recorded; checked during review/)).toHaveLength(2);
  expect(screen.getByRole('status').textContent).toContain('1 artifacts selected');
});

it('uses recorded peer authorship before user-role fallback and does not invent timestamps or progress', () => {
  const peer = message('peer', 'I am checking progress.', {
    role: 'user',
    agentMessage: {
      direction: 'incoming',
      senderName: 'Research agent',
      recipientName: 'Lead',
      timestamp: 1_800_000_000_000,
      message: {
        messageId: 'peer-id',
        commandId: 'peer',
        senderConversationId: 'research',
        recipientConversationId: 'lead',
        text: 'I am checking progress.',
        replyTo: null,
        status: 'delivered',
        reason: null,
        sequence: 1,
      },
    },
  });
  expect(contextMessagePresentation(peer)).toMatchObject({
    authorLabel: 'Research agent',
    type: 'message',
    timestamp: 1_800_000_000_000,
  });
  expect(
    contextMessagePresentation(
      message('legacy-seat', 'Retained agent context', {
        role: 'user',
        symposiumProvenance: {
          seatId: 'retained-seat',
          configRevision: 1,
          accountProfileRevision: 'account-v1',
          seatProfileRevision: 'profile-v1',
          contextGrantRevision: 1,
          authorityGrantRevision: 1,
          isolationDomainId: 'domain',
          isolationDomainRevision: 1,
        },
      }),
    ),
  ).toMatchObject({ authorId: 'seat:retained-seat', authorLabel: 'Agent · name not recorded' });
  expect(
    contextMessagePresentation(message('unknown', 'Thinking…', { timestamp: Number.NaN })),
  ).toMatchObject({
    authorLabel: 'Agent · name not recorded',
    timestamp: undefined,
    type: 'message',
  });
  render(
    <Harness
      messages={[
        peer,
        message('tool', '', {
          blocks: [{ blockId: 'tool', blockType: 'tool_use', content: 'private tool input' }],
        }),
      ]}
      messageMetadata={{}}
    />,
  );
  expect(screen.getByRole('checkbox', { name: /Research agent Message/ })).toBeTruthy();
  expect(screen.queryByText('private tool input')).toBeNull();
  expect(screen.queryByText(/Progress \(/)).toBeNull();
});
