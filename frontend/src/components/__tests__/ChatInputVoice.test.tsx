// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
import type { UseVoiceReturn } from '../../hooks/useVoice';

// Mock SlashPicker to avoid Router dependency
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
    stopRecording: vi.fn(() => Promise.resolve('hello world')),
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

describe('ChatInput with voice', () => {
  it('shows mic button when voice is available', () => {
    const voice = makeVoice();
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    expect(screen.getByTitle('Tap to record')).toBeTruthy();
  });

  it('hides mic button when voice is unavailable', () => {
    const voice = makeVoice({ available: false });
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    expect(screen.queryByTitle('Tap to record')).toBeNull();
  });

  it('hides mic button when no voice prop', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    expect(screen.queryByTitle('Tap to record')).toBeNull();
  });

  it('calls startRecording on click', () => {
    const voice = makeVoice();
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    fireEvent.click(screen.getByTitle('Tap to record'));
    expect(voice.startRecording).toHaveBeenCalledTimes(1);
  });

  it('inserts transcript into textarea on stop', async () => {
    const voice = makeVoice({ recording: true });
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );

    // Trigger stop — the onRecordStop handler calls voice.stopRecording and sets text
    fireEvent.click(screen.getByTitle('Tap to stop'));

    // Wait for the async transcript to resolve
    await vi.waitFor(() => {
      const textarea = container.querySelector('textarea');
      expect(textarea?.value).toBe('hello world');
    });
  });

  it('shows recording state', () => {
    const voice = makeVoice({ recording: true });
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );
    expect(container.querySelector('.mic-btn--recording')).toBeTruthy();
  });

  it('shows mic-blocked state', () => {
    const voice = makeVoice({ micBlocked: true });
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    expect(screen.getByTitle('Microphone blocked')).toBeTruthy();
  });

  it('shows partial transcript overlay during recording', () => {
    const voice = makeVoice({ recording: true, partialTranscript: 'hello wor' });
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );
    const overlay = container.querySelector('.voice-partial');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toBe('hello wor');
  });

  it('hides partial transcript overlay when not recording', () => {
    const voice = makeVoice({ recording: false, partialTranscript: '' });
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );
    expect(container.querySelector('.voice-partial')).toBeNull();
  });

  it('hides partial transcript overlay when partial is empty', () => {
    const voice = makeVoice({ recording: true, partialTranscript: '' });
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );
    expect(container.querySelector('.voice-partial')).toBeNull();
  });

  it('stops TTS playback when mic recording starts', () => {
    const voice = makeVoice({ speaking: true });
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    fireEvent.click(screen.getByTitle('Tap to record'));
    expect(voice.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(voice.startRecording).toHaveBeenCalledTimes(1);
  });
});
