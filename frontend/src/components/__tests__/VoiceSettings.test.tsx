// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { VoiceSettings } from '../VoiceSettings';
import type { Voice } from '../../hooks/useVoice';

afterEach(() => cleanup());

const voices: Voice[] = [
  { id: 'af_heart', name: 'Heart', language: 'American English', gender: 'female' },
  { id: 'am_adam', name: 'Adam', language: 'American English', gender: 'male' },
  { id: 'bf_alice', name: 'Alice', language: 'British English', gender: 'female' },
];

describe('VoiceSettings', () => {
  it('renders nothing when ttsAvailable is false', () => {
    const { container } = render(
      <VoiceSettings
        ttsAvailable={false}
        voices={[]}
        selectedVoice="af_heart"
        onVoiceChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing until voices have loaded', () => {
    render(
      <VoiceSettings
        ttsAvailable={true}
        voices={[]}
        selectedVoice="af_heart"
        onVoiceChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows a voice picker when TTS is available', () => {
    render(
      <VoiceSettings
        ttsAvailable={true}
        voices={voices}
        selectedVoice="af_heart"
        onVoiceChange={vi.fn()}
      />,
    );
    const select = screen.getByRole('combobox');
    expect(select).toBeTruthy();
    expect(select.getAttribute('aria-label')).toBe('Read-aloud voice');
    // Should have options for all voices
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(3);
  });

  it('calls onVoiceChange when voice selected', () => {
    const onVoiceChange = vi.fn();
    render(
      <VoiceSettings
        ttsAvailable={true}
        voices={voices}
        selectedVoice="af_heart"
        onVoiceChange={onVoiceChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'am_adam' } });
    expect(onVoiceChange).toHaveBeenCalledWith('am_adam');
  });

  it('groups voices by language', () => {
    render(
      <VoiceSettings
        ttsAvailable={true}
        voices={voices}
        selectedVoice="af_heart"
        onVoiceChange={vi.fn()}
      />,
    );
    const groups = screen.getByRole('combobox').querySelectorAll('optgroup');
    expect(groups).toHaveLength(2); // American English, British English
  });
});
