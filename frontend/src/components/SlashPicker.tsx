import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/api-fetch';

export interface SkillEntry {
  name: string;
  description: string;
  scope: 'repo' | 'user' | 'bundled' | 'native';
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
  repo: 'Workspace',
  user: 'Personal',
  bundled: 'Built-in',
  native: 'App command',
};

export function SlashPicker({ query, onSelect, onClose, cwd }: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Fetch skills on mount
  useEffect(() => {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const controller = new AbortController();
    let active = true;
    Promise.all([
      apiFetch(`/api/skills?${params.toString()}`, { signal: controller.signal }).then((r) =>
        r.json(),
      ),
      apiFetch('/api/commands', { signal: controller.signal })
        .then((r) => r.json())
        .then((entries: SkillEntry[]) =>
          Array.isArray(entries) ? entries.filter((entry) => entry.scope === 'native') : [],
        )
        .catch(() => []),
    ])
      .then(([data, commands]: [SkillEntry[], SkillEntry[]]) => {
        if (!active) return;
        setSkills([...data, ...commands]);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
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
          <p className="slash-picker-hint">
            Choose to insert. Your draft is kept; send when ready.
          </p>
          {(['skill', 'native'] as const).map((kind) => (
            <section
              key={kind}
              hidden={!sorted.some((entry) => (entry.scope === 'native') === (kind === 'native'))}
            >
              <h3>{kind === 'native' ? 'App commands' : 'Skills'}</h3>
              {sorted
                .filter((entry) => (entry.scope === 'native') === (kind === 'native'))
                .map((skill) => (
                  <button
                    key={skill.name}
                    className="slash-picker-item"
                    onClick={() => handleSelect(skill.name)}
                  >
                    <span className="slash-picker-name">/{skill.name}</span>
                    <span className="slash-picker-desc">{skill.description}</span>
                    <span className="slash-picker-scope">{SCOPE_BADGES[skill.scope]}</span>
                    {skill.collisions && skill.collisions.length > 0 && (
                      <span className="slash-picker-collision">
                        also in: {skill.collisions.map((c) => c.scope).join(', ')}
                      </span>
                    )}
                  </button>
                ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
