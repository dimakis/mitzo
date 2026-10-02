// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
import type { UseVoiceReturn } from '../../hooks/useVoice';

vi.mock('../SlashPicker', () => ({
  SlashPicker: () => null,
}));

afterEach(() => cleanup());

function makeVoice(overrides: Partial<UseVoiceReturn> = {}): UseVoiceReturn {
  return {
    available: true,
    recording: false,
    transcribing: false,
    partialTranscript: '',
    micBlocked: false,
    error: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(() => Promise.resolve('')),
    cancelRecording: vi.fn(),
    ttsAvailable: false,
    speaking: false,
    voices: [],
    selectedVoice: 'af_heart',
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    setVoice: vi.fn(),
    ...overrides,
  };
}

const noop = () => true;
const noopVoid = () => {};

describe('ChatInput command strip', () => {
  it('keeps Session with the controls, including while its resources are open', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    const session = screen.getByRole('button', { name: 'Open session tray' });
    expect(session.closest('.composer-toolbar')).toBeTruthy();
    fireEvent.click(session);
    expect(session.closest('.composer-toolbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close session tray' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss session tray' }));
    expect(session.getAttribute('aria-expanded')).toBe('false');
  });

  it('supports the complete running toolbar without losing the draft or workspace controls', () => {
    const interrupt = vi.fn();
    render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        onInterrupt={interrupt}
        running
        voice={makeVoice()}
        branch="session/123abc"
        isWorktree
        wtId="123abc"
        initialText="Keep a readable draft"
      />,
    );
    for (const name of [
      'Open session tray',
      'Record voice message',
      'Interrupt and send now',
      'Queue message',
      'Stop generation',
      'Workspace details',
    ]) {
      expect(screen.getByRole('button', { name }).closest('.composer-toolbar')).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Workspace details' }));
    expect(screen.getByText('session/123abc')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Keep a readable draft',
    );
  });

  it('keeps new-chat worktree isolation operable from the toolbar', () => {
    const onIsolationChange = vi.fn();
    render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        isolation
        onIsolationChange={onIsolationChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Worktree isolation' }));
    expect(onIsolationChange).toHaveBeenCalledWith(false);
  });

  it('dismisses secondary controls with Escape and returns to the draft', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} branch="topic" />);
    const more = screen.getByRole('button', { name: 'More composer actions' });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace details' }));
    expect(screen.getByText('topic')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('topic')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });
  it('keeps context information out of the action row and preserves expandable details', () => {
    const { container } = render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        tokenState={{
          agentContext: 5000,
          contextCeiling: 200000,
          sessionTotal: 9000,
          numTurns: 2,
          turnIndex: 1,
          numCompactions: 0,
        }}
      />,
    );
    const usage = screen.getByRole('button', { name: 'Token usage' });
    expect(usage.closest('.composer-toolbar')).toBeNull();
    expect(usage.closest('.composer-info')).toBeTruthy();
    fireEvent.click(usage);
    expect(screen.getByText('Agent context').closest('.composer-info')).toBeTruthy();
    expect(container.querySelector('.composer-toolbar')?.querySelector('textarea')).toBeNull();
  });
  it('keeps image attachment directly available while retaining the session tray source action', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    expect(screen.getByTitle('Skills')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
    expect(screen.getByRole('button', { name: 'Add source' })).toBeTruthy();
  });

  it('keeps technical branch and session identifiers out of the composer', () => {
    const { container } = render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        branch="session/123abc"
        isWorktree
        wtId="123abc"
        sessionId="abcdef123456"
      />,
    );
    expect(container.querySelector('.chat-input-branch')).toBeNull();
    expect(container.querySelector('.chat-input-session-hash')).toBeNull();
    expect(screen.getByRole('button', { name: 'Commands' })).toBeTruthy();
  });

  it('renders mic button in input row, not command strip', () => {
    const voice = makeVoice();
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );
    const strip = container.querySelector('.chat-input-command-strip');
    expect(strip?.querySelector('.mic-btn')).toBeNull();
    const row = container.querySelector('.chat-input-row');
    expect(row?.querySelector('.mic-btn')).toBeTruthy();
  });

  it('keeps single mic button regardless of text input', () => {
    const voice = makeVoice();
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );

    // Initially empty — one mic
    const mics = container.querySelectorAll('.mic-btn');
    expect(mics).toHaveLength(1);

    // Type text — still one mic in same position
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    expect(container.querySelectorAll('.mic-btn')).toHaveLength(1);
  });

  it('does not render session hash badge when sessionId is undefined', () => {
    const { container } = render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    expect(container.querySelector('.chat-input-session-hash')).toBeNull();
  });

  it('opens slash picker when / button is clicked', () => {
    const { container } = render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    fireEvent.click(screen.getByTitle('Skills'));
    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('/');
  });
});
