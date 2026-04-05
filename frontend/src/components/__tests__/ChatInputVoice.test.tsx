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
    expect(screen.getByTitle('Hold to record')).toBeTruthy();
  });

  it('hides mic button when voice is unavailable', () => {
    const voice = makeVoice({ available: false });
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    expect(screen.queryByTitle('Hold to record')).toBeNull();
  });

  it('hides mic button when no voice prop', () => {
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} />);
    expect(screen.queryByTitle('Hold to record')).toBeNull();
  });

  it('calls startRecording on pointer down', () => {
    const voice = makeVoice();
    render(<ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />);
    fireEvent.pointerDown(screen.getByTitle('Hold to record'));
    expect(voice.startRecording).toHaveBeenCalledTimes(1);
  });

  it('inserts transcript into textarea on stop', async () => {
    const voice = makeVoice({ recording: true });
    const { container } = render(
      <ChatInput onSend={noop} onStop={noopVoid} running={false} voice={voice} />,
    );

    // Trigger stop — the onRecordStop handler calls voice.stopRecording and sets text
    fireEvent.pointerUp(screen.getByTitle('Release to send'));

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
});
