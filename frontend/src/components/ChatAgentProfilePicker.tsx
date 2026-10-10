import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AgentProfileSelectionSchema,
  agentProfileLabel,
  type AgentLibraryVersion,
  type AgentLibraryCatalog,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import './ChatAgentProfilePicker.css';

export function ChatAgentProfilePicker({
  sessionId,
  search,
  onChange,
  disabled = false,
}: {
  sessionId: string | null;
  search: string;
  disabled?: boolean;
  onChange(selection: AgentProfileSelection | null, blockedReason?: string): void;
}) {
  const [versions, setVersions] = useState<AgentLibraryVersion[]>([]);
  const [selected, setSelected] = useState<AgentProfileSelection | null>(null);
  const [pinned, setPinned] = useState<AgentLibraryVersion | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);
  const params = new URLSearchParams(search);
  const requiredId = params.get('agentProfile');
  const requiredRevision = params.get('profileRevision');
  useEffect(() => {
    let live = true;
    const required = requiredId !== null || requiredRevision !== null;
    const parsed = required
      ? AgentProfileSelectionSchema.safeParse({
          profileId: requiredId,
          revision: Number(requiredRevision),
        })
      : null;
    const requested = parsed?.success ? parsed.data : null;
    setLoading(true);
    setError('');
    setPinned(null);
    setSelected(requested);
    if (!sessionId)
      changed.current(requested, required ? 'Loading the selected agent profile…' : undefined);
    if (!sessionId && required && !requested) {
      setError('The selected agent profile is invalid. Choose another profile.');
      changed.current(null, 'The selected agent profile is invalid.');
      setLoading(false);
      return () => {
        live = false;
      };
    }
    const path = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/meta`
      : '/api/agent-library';
    apiFetch(path)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw Error(body?.error || 'Agent Library unavailable');
        if (!live) return;
        if (sessionId) {
          setPinned(body.agentProfile ?? null);
          return;
        }
        const catalog = body as AgentLibraryCatalog;
        if (!Array.isArray(catalog.versions)) throw Error('Agent Library response is invalid');
        setVersions(catalog.versions);
        if (
          requested &&
          !catalog.versions.some(
            (v) => v.profileId === requested.profileId && v.revision === requested.revision,
          )
        )
          throw Error('The selected agent revision is unavailable. Choose another profile.');
        changed.current(requested, undefined);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        const message = cause instanceof Error ? cause.message : 'Agent Library unavailable';
        setError(message);
        if (!sessionId) changed.current(null, required ? message : undefined);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [sessionId, requiredId, requiredRevision]);
  if (sessionId)
    return pinned ? (
      <div className="chat-agent-profile">
        <span>
          {agentProfileLabel(pinned.definition)} · r{pinned.revision}
        </span>
        <Link to="/agent-library">Library</Link>
      </div>
    ) : null;
  const latest = new Map<string, AgentLibraryVersion>();
  for (const version of versions)
    if (
      !latest.has(version.profileId) ||
      latest.get(version.profileId)!.revision < version.revision
    )
      latest.set(version.profileId, version);
  const eligible = [...latest.values()];
  const historical = versions.find(
    (v) => v.profileId === selected?.profileId && v.revision === selected?.revision,
  );
  if (historical && !eligible.includes(historical)) eligible.push(historical);
  return (
    <div className="chat-agent-profile">
      <label>
        Agent profile
        <select
          disabled={disabled || loading}
          value={selected ? `${selected.profileId}:${selected.revision}` : ''}
          onChange={(e) => {
            const version = eligible.find((v) => `${v.profileId}:${v.revision}` === e.target.value);
            const selection = version
              ? { profileId: version.profileId, revision: version.revision }
              : null;
            setSelected(selection);
            setError('');
            changed.current(selection, undefined);
          }}
        >
          <option value="">Default Mitzo</option>
          {eligible.map((v) => (
            <option key={`${v.profileId}:${v.revision}`} value={`${v.profileId}:${v.revision}`}>
              {agentProfileLabel(v.definition)} · r{v.revision}
            </option>
          ))}
        </select>
      </label>
      <Link to="/agent-library">Library</Link>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
