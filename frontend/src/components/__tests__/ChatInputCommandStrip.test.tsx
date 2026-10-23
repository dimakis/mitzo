// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
import type { UseVoiceReturn } from '../../hooks/useVoice';

vi.mock('../SlashPicker', () => ({
  SlashPicker: () => null,
}));

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
  localStorage.clear();
});

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
  it('keeps send icon-only even for a new session and distinguishes live dictation', () => {
    const { container, rerender } = render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        initialText="Keep the draft"
        sendLabel="Start session"
        voice={makeVoice({ recording: true, partialTranscript: 'Words arrive' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Start session' }).textContent).toBe('');
    expect(container.querySelector('.voice-partial em')?.textContent).toBe('Words arrive');
    rerender(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        voice={makeVoice({ recording: true, partialTranscript: 'Words arrive one by one' })}
      />,
    );
    expect(container.querySelector('.voice-partial em')?.textContent).toBe(
      'Words arrive one by one',
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep the draft');
  });
  it('keeps agent settings between the message and toolbar without changing the draft', () => {
    const { container, rerender } = render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        initialText="Keep this draft"
        settings={<button>Agent settings</button>}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const settings = screen.getByRole('button', { name: 'Agent settings' });
    const row = container.querySelector('.chat-input-row')!;
    expect(settings.closest('.chat-input-row')).toBe(row);
    expect(input.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      settings.compareDocumentPosition(container.querySelector('.composer-toolbar')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Edited draft' } });
    rerender(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running
        settings={<button>Agent settings</button>}
      />,
    );
    expect(input.value).toBe('Edited draft');
    expect(screen.getAllByRole('button', { name: 'Agent settings' })).toHaveLength(1);
  });

  it('names a new conversation action without changing normal message sends', () => {
    const onSend = vi.fn(() => true);
    const { rerender } = render(
      <ChatInput
        onSend={onSend}
        onStop={noopVoid}
        running={false}
        initialText="Start the work"
        sendLabel="Start session"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(<ChatInput onSend={onSend} onStop={noopVoid} running={false} />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  });

  it('keeps Session with the controls, including while its resources are open', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    const session = screen.getByRole('button', { name: 'Open session tray' });
    expect(session.textContent).toBe('');
    expect(session.closest('.composer-toolbar')).toBeTruthy();
    fireEvent.click(session);
    expect(session.closest('.composer-toolbar')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Resources' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
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
  it('keeps the context wheel in the toolbar and preserves expandable details', () => {
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
    expect(usage.closest('.composer-actions')).toBeTruthy();
    expect(usage.closest('.composer-actions')?.firstElementChild?.contains(usage)).toBe(true);
    expect(usage.closest('.composer-actions')?.lastElementChild).toBe(
      screen.getByRole('button', { name: 'Send message' }),
    );
    expect(container.querySelector('.composer-info')).toBeNull();
    fireEvent.click(usage);
    expect(screen.getByText('Current context').closest('.token-wheel-control')).toBeTruthy();
    expect(container.querySelector('.composer-toolbar')?.querySelector('textarea')).toBeNull();
  });
  it('keeps image attachment directly available while retaining the session tray source action', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    expect(screen.getByRole('button', { name: 'Commands' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach images or PDF' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
    expect(screen.getByRole('button', { name: 'Add images' })).toBeTruthy();
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

  it('uses the shared command-list icon and keeps its name discoverable', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    const commands = screen.getByRole('button', { name: 'Commands' });
    expect(commands.querySelector('.ui-icon[data-icon="command"]')).toBeTruthy();
    expect(commands.getAttribute('title')).toBe('Commands');
    expect(commands.querySelector('[aria-hidden="true"]')?.textContent).not.toBe('/');
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Keep the current question' } });
    fireEvent.click(commands);
    expect(input.value).toBe('Keep the current question');
    expect(commands.getAttribute('aria-expanded')).toBe('true');
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

  it('opens slash picker when the command icon is clicked', () => {
    const { container } = render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commands' }));
    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('/');
  });
});

it('leaves the phone keyboard closed on entry, including a restored draft', () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  try {
    render(
      <ChatInput
        onSend={noop}
        onStop={noopVoid}
        running={false}
        initialText="Restored mobile draft"
      />,
    );
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  } finally {
    vi.unstubAllGlobals();
  }
});
