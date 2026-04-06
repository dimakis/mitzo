// TTS toggle + voice picker. Rendered in the chat header.

import type { Voice } from '../hooks/useVoice';

interface Props {
  ttsAvailable: boolean;
  ttsEnabled: boolean;
  speaking: boolean;
  voices: Voice[];
  selectedVoice: string;
  onToggle: () => void;
  onVoiceChange: (id: string) => void;
}

export function VoiceSettings({
  ttsAvailable,
  ttsEnabled,
  speaking,
  voices,
  selectedVoice,
  onToggle,
  onVoiceChange,
}: Props) {
  if (!ttsAvailable) return null;

  const toggleClass = [
    'voice-toggle',
    ttsEnabled ? 'voice-toggle--active' : '',
    speaking ? 'voice-toggle--speaking' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Group voices by language
  const grouped = new Map<string, Voice[]>();
  for (const v of voices) {
    const list = grouped.get(v.language) ?? [];
    list.push(v);
    grouped.set(v.language, list);
  }

  return (
    <div className="voice-settings">
      <button
        className={toggleClass}
        onClick={onToggle}
        title={ttsEnabled ? 'Disable text-to-speech' : 'Enable text-to-speech'}
      >
        {speaking ? '\uD83D\uDD0A' : ttsEnabled ? '\uD83D\uDD09' : '\uD83D\uDD08'}
      </button>

      {ttsEnabled && voices.length > 0 && (
        <select
          className="voice-picker"
          value={selectedVoice}
          onChange={(e) => onVoiceChange(e.target.value)}
        >
          {[...grouped.entries()].map(([lang, langVoices]) => (
            <optgroup key={lang} label={lang}>
              {langVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.gender})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}
