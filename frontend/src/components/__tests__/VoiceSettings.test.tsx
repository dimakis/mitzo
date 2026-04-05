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
        ttsEnabled={false}
        speaking={false}
        voices={[]}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows speaker toggle when ttsAvailable', () => {
    render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={false}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Enable text-to-speech')).toBeTruthy();
  });

  it('shows active state when ttsEnabled', () => {
    const { container } = render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={true}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    expect(container.querySelector('.voice-toggle--active')).toBeTruthy();
    expect(screen.getByTitle('Disable text-to-speech')).toBeTruthy();
  });

  it('shows speaking animation when speaking', () => {
    const { container } = render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={true}
        speaking={true}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    expect(container.querySelector('.voice-toggle--speaking')).toBeTruthy();
  });

  it('calls onToggle when speaker button clicked', () => {
    const onToggle = vi.fn();
    render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={false}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={onToggle}
        onVoiceChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Enable text-to-speech'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows voice picker when ttsEnabled', () => {
    render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={true}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    const select = screen.getByRole('combobox');
    expect(select).toBeTruthy();
    // Should have options for all voices
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(3);
  });

  it('hides voice picker when ttsEnabled is false', () => {
    render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={false}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('calls onVoiceChange when voice selected', () => {
    const onVoiceChange = vi.fn();
    render(
      <VoiceSettings
        ttsAvailable={true}
        ttsEnabled={true}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
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
        ttsEnabled={true}
        speaking={false}
        voices={voices}
        selectedVoice="af_heart"
        onToggle={vi.fn()}
        onVoiceChange={vi.fn()}
      />,
    );
    const groups = screen.getByRole('combobox').querySelectorAll('optgroup');
    expect(groups).toHaveLength(2); // American English, British English
  });
});
