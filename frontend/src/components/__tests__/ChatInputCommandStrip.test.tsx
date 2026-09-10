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
    ttsEnabled: false,
    speaking: false,
    voices: [],
    selectedVoice: 'af_heart',
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    setTtsEnabled: vi.fn(),
    setVoice: vi.fn(),
    ...overrides,
  };
}

const noop = () => true;
const noopVoid = () => {};

describe('ChatInput command strip', () => {
  it('keeps skills in the strip and moves attachments into the session tray', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    expect(screen.getByTitle('Skills')).toBeTruthy();
    expect(screen.queryByTitle('Attach image')).toBeNull();
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
