import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  profileBuilderDefinition,
  profileBuilderDefinitionForRevision,
  AgentProfileSelectionSchema,
  agentProfileLabel,
  type AgentLibraryVersion,
  type AgentLibraryCatalog,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import './ChatAgentProfilePicker.css';

type ProfileOption = Pick<AgentLibraryVersion, 'kind' | 'profileId' | 'revision' | 'definition'>;

const optionKey = (selection: AgentProfileSelection) =>
  JSON.stringify([selection.kind ?? 'saved', selection.profileId, selection.revision]);
const identityKey = (selection: AgentProfileSelection) =>
  JSON.stringify([selection.kind ?? 'saved', selection.profileId]);

export function ChatAgentProfilePicker(
  props: Parameters<typeof LibraryChatAgentProfilePicker>[0] & {
    controlled?: {
      versions: AgentLibraryVersion[];
      selection: AgentProfileSelection | null;
      onChange(selection: AgentProfileSelection | null): void;
    };
  },
) {
  if (props.controlled)
    return (
      <ControlledAgentProfilePicker
        {...props.controlled}
        disabled={props.disabled}
        label={props.label}
        onLabelChange={props.onLabelChange}
      />
    );
  return <LibraryChatAgentProfilePicker {...props} />;
}
function LibraryChatAgentProfilePicker({
  sessionId,
  search,
  onChange,
  disabled = false,
  updateSearchParams = true,
  allowedRoles,
  label = 'Agent profile',
  onLabelChange,
}: {
  label?: string;
  onLabelChange?(label: string | undefined): void;
  sessionId: string | null;
  search: string;
  disabled?: boolean;
  /** Contributor dialogs select guidance without replacing the source chat's profile. */
  updateSearchParams?: boolean;
  allowedRoles?: string[];
  onChange(selection: AgentProfileSelection | null, blockedReason?: string): void;
}) {
  const [, setSearchParams] = useSearchParams();
  const [versions, setVersions] = useState<ProfileOption[]>([]);
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
  const requiredKind = params.get('agentProfileKind');
  useEffect(() => {
    let live = true;
    const required = requiredId !== null || requiredRevision !== null || requiredKind !== null;
    const parsed = required
      ? AgentProfileSelectionSchema.safeParse({
          profileId: requiredId,
          revision: Number(requiredRevision),
          ...(requiredKind !== null ? { kind: requiredKind } : {}),
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
        const available =
          requested?.kind === 'builtin' && requested.profileId === PROFILE_BUILDER_ID
            ? [
                ...catalog.versions,
                {
                  kind: 'builtin' as const,
                  profileId: PROFILE_BUILDER_ID,
                  revision: PROFILE_BUILDER_REVISION,
                  definition: profileBuilderDefinition,
                },
              ]
            : catalog.versions;
        if (
          requested?.kind === 'builtin' &&
          requested.profileId === PROFILE_BUILDER_ID &&
          requested.revision !== PROFILE_BUILDER_REVISION
        ) {
          const historical = profileBuilderDefinitionForRevision(requested.revision);
          if (historical)
            available.push({
              kind: 'builtin',
              profileId: PROFILE_BUILDER_ID,
              revision: requested.revision,
              definition: historical,
            });
        }
        setVersions(available);
        if (
          requested &&
          !available.some(
            (v) =>
              v.kind === requested.kind &&
              v.profileId === requested.profileId &&
              v.revision === requested.revision &&
              (!allowedRoles || allowedRoles.includes(v.definition.role)),
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
  }, [sessionId, requiredId, requiredRevision, requiredKind, allowedRoles]);
  useEffect(() => {
    const trusted = sessionId
      ? pinned
      : versions.find(
          (v) =>
            optionKey(v) === (selected ? optionKey(selected) : '') &&
            (!allowedRoles || allowedRoles.includes(v.definition.role)),
        );
    onLabelChange?.(
      loading || error
        ? undefined
        : trusted
          ? agentProfileLabel(trusted.definition)
          : selected
            ? undefined
            : 'Default Mitzo',
    );
  }, [sessionId, pinned, versions, selected, allowedRoles, loading, error, onLabelChange]);
  if (sessionId)
    return pinned ? (
      <div className="chat-agent-profile">
        <span>
          {agentProfileLabel(pinned.definition)} · r{pinned.revision}
        </span>
        <Link to="/agent-library">Library</Link>
      </div>
    ) : null;
  const latest = new Map<string, ProfileOption>();
  for (const version of versions)
    if (
      !latest.has(identityKey(version)) ||
      latest.get(identityKey(version))!.revision < version.revision
    )
      latest.set(identityKey(version), version);
  const eligible = [...latest.values()].filter(
    (version) => !allowedRoles || allowedRoles.includes(version.definition.role),
  );
  const historical = versions.find(
    (v) =>
      v.kind === selected?.kind &&
      v.profileId === selected?.profileId &&
      v.revision === selected?.revision,
  );
  if (
    historical &&
    (!allowedRoles || allowedRoles.includes(historical.definition.role)) &&
    !eligible.includes(historical)
  )
    eligible.push(historical);
  return (
    <div className="chat-agent-profile">
      <label>
        {label}
        <select
          aria-label={label}
          disabled={disabled || loading}
          value={selected ? optionKey(selected) : ''}
          onChange={(e) => {
            const version = eligible.find((v) => optionKey(v) === e.target.value);
            const selection = version
              ? {
                  profileId: version.profileId,
                  revision: version.revision,
                  ...(version.kind ? { kind: version.kind } : {}),
                }
              : null;
            setSelected(selection);
            setError('');
            changed.current(selection, undefined);
            if (updateSearchParams)
              setSearchParams(
                (params) => {
                  const next = new URLSearchParams(params);
                  if (selection) {
                    next.set('agentProfile', selection.profileId);
                    next.set('profileRevision', String(selection.revision));
                    if (selection.kind) next.set('agentProfileKind', selection.kind);
                    else next.delete('agentProfileKind');
                  } else {
                    next.delete('agentProfile');
                    next.delete('profileRevision');
                    next.delete('agentProfileKind');
                  }
                  return next;
                },
                { replace: true },
              );
          }}
        >
          <option value="">Default Mitzo</option>
          {eligible.map((v) => (
            <option key={optionKey(v)} value={optionKey(v)}>
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

const controlledProfileKey = (selection: AgentProfileSelection) =>
  JSON.stringify([
    ('kind' in selection ? selection.kind : undefined) ?? 'saved',
    selection.profileId,
    selection.revision,
  ]);

function ControlledAgentProfilePicker({
  versions,
  selection,
  onChange,
  disabled,
  label = 'Agent',
  onLabelChange,
}: {
  label?: string;
  onLabelChange?(label: string | undefined): void;
  versions: AgentLibraryVersion[];
  selection: AgentProfileSelection | null;
  onChange(selection: AgentProfileSelection | null): void;
  disabled?: boolean;
}) {
  const [, setSearchParams] = useSearchParams();
  useEffect(() => {
    const trusted = versions.find(
      (v) => selection && controlledProfileKey(v) === controlledProfileKey(selection),
    );
    onLabelChange?.(trusted ? agentProfileLabel(trusted.definition) : undefined);
  }, [versions, selection, onLabelChange]);
  const value = selection ? controlledProfileKey(selection) : '';
  return (
    <div className="chat-agent-profile">
      <label>
        {label}
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const selected = versions.find((v) => controlledProfileKey(v) === e.target.value);
            onChange(
              selected ? { profileId: selected.profileId, revision: selected.revision } : null,
            );
            setSearchParams(
              (params) => {
                const next = new URLSearchParams(params);
                next.delete('agentProfileKind');
                if (selected) {
                  next.set('agentProfile', selected.profileId);
                  next.set('profileRevision', String(selected.revision));
                } else {
                  next.delete('agentProfile');
                  next.delete('profileRevision');
                }
                return next;
              },
              { replace: true },
            );
          }}
        >
          <option value="">Choose published agent</option>
          {value && !versions.some((v) => controlledProfileKey(v) === value) && (
            <option value={value} disabled>
              Unavailable {selection && 'kind' in selection ? 'builtin agent' : 'agent'} · r
              {selection!.revision}
            </option>
          )}
          {versions.map((v) => (
            <option key={controlledProfileKey(v)} value={controlledProfileKey(v)}>
              {agentProfileLabel(v.definition)} · r{v.revision}
            </option>
          ))}
        </select>
      </label>
      <Link to="/agent-library">Library</Link>
    </div>
  );
}
