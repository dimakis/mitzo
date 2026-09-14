// Voice picker for explicit per-message read-aloud. Rendered in the chat header.

import type { Voice } from '../hooks/useVoice';

interface Props {
  ttsAvailable: boolean;
  voices: Voice[];
  selectedVoice: string;
  onVoiceChange: (id: string) => void;
}

export function VoiceSettings({ ttsAvailable, voices, selectedVoice, onVoiceChange }: Props) {
  if (!ttsAvailable || voices.length === 0) return null;

  // Group voices by language
  const grouped = new Map<string, Voice[]>();
  for (const v of voices) {
    const list = grouped.get(v.language) ?? [];
    list.push(v);
    grouped.set(v.language, list);
  }

  return (
    <div className="voice-settings">
      <select
        className="voice-picker"
        value={selectedVoice}
        onChange={(e) => onVoiceChange(e.target.value)}
        aria-label="Read-aloud voice"
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
    </div>
  );
}
