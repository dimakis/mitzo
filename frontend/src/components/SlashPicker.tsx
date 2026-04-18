import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/api-fetch';

export interface SkillEntry {
  name: string;
  description: string;
  scope: 'repo' | 'user' | 'bundled';
  allowedTools?: string[];
  collisions?: Array<{ scope: string; description: string }>;
}

interface Props {
  /** Current text in the input field */
  query: string;
  /** Called when the user selects a skill */
  onSelect: (name: string) => void;
  /** Called when the picker should close */
  onClose: () => void;
  /** Base URL for the API (defaults to empty string for same-origin) */
  cwd?: string;
}

const SCOPE_BADGES: Record<string, string> = {
  repo: '📂',
  user: '👤',
  bundled: '📦',
};

export function SlashPicker({ query, onSelect, onClose, cwd }: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Fetch skills on mount
  useEffect(() => {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    apiFetch(`/api/skills?${params.toString()}`)
      .then((r) => r.json())
      .then((data: SkillEntry[]) => {
        setSkills(data);
        setLoaded(true);
      })
      .catch(() => {
        setLoaded(true);
      });
  }, [cwd]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Filter by typed text after /
  const filterText = query.startsWith('/') ? query.slice(1).toLowerCase() : '';
  const filtered = filterText
    ? skills.filter((s) => s.name.toLowerCase().includes(filterText))
    : skills;

  // Sort: repo first, then user, then bundled
  const scopeOrder: Record<string, number> = { repo: 0, user: 1, bundled: 2 };
  const sorted = [...filtered].sort(
    (a, b) => (scopeOrder[a.scope] ?? 3) - (scopeOrder[b.scope] ?? 3),
  );

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name);
    },
    [onSelect],
  );

  if (!loaded) return null;

  return (
    <div className="slash-picker" ref={pickerRef}>
      {sorted.length === 0 ? (
        <div className="slash-picker-empty">
          {filterText ? `No commands matching "/${filterText}"` : 'No skills available'}
        </div>
      ) : (
        <div className="slash-picker-list">
          {sorted.map((skill) => (
            <button
              key={skill.name}
              className="slash-picker-item"
              onClick={() => handleSelect(skill.name)}
            >
              <span className="slash-picker-scope">{SCOPE_BADGES[skill.scope] || '?'}</span>
              <span className="slash-picker-name">/{skill.name}</span>
              <span className="slash-picker-desc">{skill.description}</span>
              {skill.collisions && skill.collisions.length > 0 && (
                <span className="slash-picker-collision">
                  also in: {skill.collisions.map((c) => c.scope).join(', ')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
