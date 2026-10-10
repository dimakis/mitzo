import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentProfileSelection, SessionOutputCandidate } from '@mitzo/protocol';
import type { OutputContributor, OutputContributorPanelProps } from '../types/output-contributors';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { ChatAgentProfilePicker } from './ChatAgentProfilePicker';
import { HomeDialog } from './HomeDialog';
import { TextBubble } from './MessageBubble';
import { UiIcon } from './UiIcon';
import './OutputContributorPanel.css';
const ORDINARY_GUIDANCE_ROLES = ['coder'];

/** Reset local drafts on an actual source/revision change; late operations remain on their old view. */
export function OutputContributorPanel(props: OutputContributorPanelProps) {
  return (
    <OutputPanel
      key={`${props.sessionId}:${props.selected?.output.outputId ?? ''}:${props.selected?.output.revision ?? ''}:${props.selected?.contextPackageDigest ?? ''}`}
      {...props}
    />
  );
}

function AddContributor({
  selected,
  onAdd,
  onClose,
  accountIds,
  available,
  accessReason,
}: {
  selected: NonNullable<OutputContributorPanelProps['selected']>;
  onAdd: OutputContributorPanelProps['onAdd'];
  onClose(): void;
  accountIds?: string[];
  available: boolean;
  accessReason: string;
}) {
  const [label, setLabel] = useState('');
  const [account, setAccount] = useState<AccountSelection | null>(null);
  const [profile, setProfile] = useState<AgentProfileSelection | null>(null);
  const [profileError, setProfileError] = useState('');
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<'ask' | 'agent' | 'auto'>('ask');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (
      !account?.accountId ||
      !label.trim() ||
      !selected.contextPackageDigest ||
      busy ||
      profileError ||
      !available
    )
      return;
    setBusy(true);
    setError('');
    try {
      await onAdd({
        ...account,
        accountId: account.accountId,
        label: label.trim(),
        instructions: instructions.trim(),
        mode,
        ...(profile ? { profileSelection: profile } : {}),
        outputId: selected.output.outputId,
        outputRevision: selected.output.revision,
        contextPackageDigest: selected.contextPackageDigest,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Contributor could not be added.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <HomeDialog
      title="Add contributor"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="output-contributor-form">
        <p>Start an independent conversation using one of your existing accounts.</p>
        <label>
          Contributor name
          <input
            value={label}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <AccountModelPicker
          scope="chat"
          sessionId={null}
          preferredModel=""
          draftOnly
          requireExplicitSelection
          allowedAccountIds={accountIds}
          disabled={busy}
          onChange={setAccount}
        />
        <section aria-label="Selected context" className="output-contributor-context">
          <strong>
            {selected.output.title} · revision {selected.output.revision}
          </strong>
          <p>
            This exact draft is shared; parent conversation history is not shared. The contributor's
            own conversation history continues between turns.
          </p>
          <details>
            <summary>Inspect draft</summary>
            <TextBubble content={selected.content ?? ''} />
          </details>
        </section>
        <ChatAgentProfilePicker
          sessionId={null}
          search=""
          updateSearchParams={false}
          allowedRoles={ORDINARY_GUIDANCE_ROLES}
          disabled={busy}
          onChange={(selection, blockedReason) => {
            if (blockedReason && (selection || profile)) {
              if (selection) setProfile(selection);
              setProfileError(blockedReason);
              return;
            }
            setProfile(selection);
            setProfileError('');
          }}
        />
        <p>
          Use a writing profile here. Profiles requiring isolated review remain in the existing
          review flow.
        </p>
        <label>
          Additional guidance
          <textarea
            value={instructions}
            maxLength={6000}
            disabled={busy}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <label>
          Session mode
          <select
            value={mode}
            disabled={busy}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="ask">Ask</option>
            <option value="agent">Agent</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <p>
          Uses ordinary session permissions and account access. Mode and guidance do not establish a
          separate filesystem boundary.
        </p>
        {(error || profileError) && <p role="alert">{error || profileError}</p>}
        {!available && (
          <p role="status">
            {accessReason || 'Contributor access must be verified before adding this conversation.'}
          </p>
        )}
        <button
          className="home-secondary"
          type="button"
          disabled={
            busy ||
            !account?.accountId ||
            !label.trim() ||
            !selected.contextPackageDigest ||
            !!profileError ||
            !available
          }
          onClick={() => void submit()}
        >
          {busy ? 'Adding contributor…' : 'Add to this output'}
        </button>
      </div>
    </HomeDialog>
  );
}

function ContributorRow({
  contributor,
  enabled,
  onSend,
  onStop,
}: {
  contributor: OutputContributor;
  enabled: boolean;
  onSend: OutputContributorPanelProps['onSend'];
  onStop: OutputContributorPanelProps['onStop'];
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    if (!draft.trim() || !enabled || sending || contributor.status === 'running') return;
    const sent = draft;
    setSending(true);
    setError('');
    try {
      await onSend(contributor.id, sent);
      setDraft((current) => (current === sent ? '' : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message not accepted.');
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    if (stopping) return;
    setStopping(true);
    setError('');
    try {
      await onStop(contributor.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Stop could not be confirmed.');
    } finally {
      setStopping(false);
    }
  }
  return (
    <li className="output-contributor-row">
      <div>
        <strong>{contributor.label}</strong>
        <p>
          {contributor.accountLabel} · {contributor.model} · {contributor.status}
        </p>
        <p>Contributing to revision {contributor.outputRevision}.</p>
      </div>
      {!!contributor.messages?.some((message) => message.role === 'assistant') && (
        <section aria-label={`Replies from ${contributor.label}`}>
          {contributor.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => (
              <div key={message.messageId}>
                <strong>
                  {message.symposiumProvenance && 'version' in message.symposiumProvenance
                    ? `${message.symposiumProvenance.seatLabel} · ${message.symposiumProvenance.accountBinding.accountLabel} · ${message.symposiumProvenance.accountBinding.model}`
                    : `${contributor.label} · ${contributor.accountLabel} · ${contributor.model}`}
                </strong>
                {message.blocks
                  .filter((block) => block.blockType === 'text')
                  .map((block) => (
                    <TextBubble
                      key={block.blockId}
                      content={block.content}
                      artifactSessionId={contributor.sessionId ?? undefined}
                    />
                  ))}
              </div>
            ))}
        </section>
      )}
      {contributor.sessionId && (
        <Link to={`/chat/${encodeURIComponent(contributor.sessionId)}`}>
          Open conversation
          <UiIcon name="forward" size={16} />
        </Link>
      )}
      <label>
        Message to {contributor.label}
        <textarea
          value={draft}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {contributor.status === 'running' && (
        <p role="status">
          Wait for this contributor to finish, or use Stop. Your next message stays here.
        </p>
      )}
      <div className="home-inline-actions">
        <button
          className="home-secondary"
          disabled={
            !enabled ||
            contributor.status === 'unavailable' ||
            contributor.status === 'running' ||
            contributor.status === 'stopping' ||
            sending ||
            !draft.trim()
          }
          type="button"
          onClick={() => void send()}
        >
          {sending ? `Sending to ${contributor.label}…` : `Send to ${contributor.label}`}
        </button>
        {(contributor.status === 'running' || contributor.status === 'stopping') && (
          <button
            className="home-secondary"
            type="button"
            disabled={stopping || contributor.status === 'stopping'}
            onClick={() => void stop()}
          >
            {stopping ? `Stopping ${contributor.label}…` : `Stop ${contributor.label}`}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

function OutputPanel(props: OutputContributorPanelProps) {
  const candidates = props.candidates.filter(
    (candidate) =>
      !props.outputs.some(
        (output) =>
          output.source.messageId === candidate.source.messageId &&
          output.source.blockId === candidate.source.blockId &&
          output.source.messageEndSeq === candidate.source.messageEndSeq &&
          output.source.sha256 === candidate.source.sha256,
      ),
  );
  const [registering, setRegistering] = useState(false);
  const [candidate, setCandidate] = useState<SessionOutputCandidate | null>(null);
  const [title, setTitle] = useState('');
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [adding, setAdding] = useState(false);
  const selected = props.selected;
  const enabled =
    props.eligibility.available === true &&
    !!selected?.contextPackageDigest &&
    selected.content !== null &&
    selected.output.sourceAvailability === 'available';
  async function register() {
    if (!candidate || !title.trim() || registerBusy) return;
    setRegisterBusy(true);
    setRegisterError('');
    try {
      await props.onRegister(candidate, title.trim());
      setRegistering(false);
    } catch (cause) {
      setRegisterError(cause instanceof Error ? cause.message : 'Draft could not be registered.');
    } finally {
      setRegisterBusy(false);
    }
  }
  if (!props.outputs.length && !candidates.length && !props.loading && !props.error) return null;
  return (
    <section className="output-contributor-panel" aria-label="Outputs">
      <header>
        <h2>Outputs</h2>
        {!!candidates.length && (
          <button
            className="home-secondary"
            type="button"
            onClick={(event) => {
              event.currentTarget.focus();
              setCandidate(candidates[0] ?? null);
              setRegistering(true);
            }}
          >
            Keep as output
          </button>
        )}
      </header>
      {props.loading && <p role="status">Loading outputs…</p>}
      {props.error && (
        <p role="alert">
          {props.error}{' '}
          <button className="home-secondary" type="button" onClick={props.onRefresh}>
            Retry outputs
          </button>
        </p>
      )}
      {!!props.outputs.length && (
        <label className="output-contributor-selection">
          Selected output
          <select
            value={selected?.output.outputId ?? ''}
            onChange={(event) => props.onSelect(event.target.value)}
          >
            <option value="" disabled>
              Choose an output
            </option>
            {props.outputs.map((output) => (
              <option key={output.outputId} value={output.outputId}>
                {output.title} · revision {output.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <>
          <h3>{selected.output.title}</h3>
          <p>
            In conversation · revision {selected.output.revision}. This reference depends on this
            conversation's retained transcript.
          </p>
          {selected.content !== null ? (
            <TextBubble content={selected.content} artifactSessionId={props.sessionId} />
          ) : (
            <p role="status">The registered draft is currently unavailable.</p>
          )}
          <div className="home-inline-actions">
            <button
              className="home-secondary"
              type="button"
              disabled={!enabled}
              onClick={(event) => {
                event.currentTarget.focus();
                setAdding(true);
              }}
            >
              Add contributor
            </button>
            <button className="home-secondary" type="button" onClick={props.onRefresh}>
              Refresh access
            </button>
          </div>
          <p role="status">
            {props.eligibility.reason ||
              (props.eligibility.available === null
                ? 'Contributor access has not been verified.'
                : '')}
          </p>
          <ul className="output-contributor-list" aria-label="Contributors">
            {props.contributors
              .filter((contributor) => contributor.outputId === selected.output.outputId)
              .map((contributor) => (
                <ContributorRow
                  key={contributor.id}
                  contributor={contributor}
                  enabled={enabled && contributor.outputRevision === selected.output.revision}
                  onSend={props.onSend}
                  onStop={props.onStop}
                />
              ))}
          </ul>
        </>
      )}
      {registering && (
        <HomeDialog
          title="Keep an output"
          onClose={() => {
            if (!registerBusy) setRegistering(false);
          }}
        >
          <div className="output-contributor-form">
            <p>Register an exact finalized draft. Its content remains in this conversation.</p>
            <label>
              Finalized draft
              <select
                value={
                  candidate
                    ? `${candidate.source.messageId}:${candidate.source.blockId}:${candidate.source.sha256}`
                    : ''
                }
                disabled={registerBusy}
                onChange={(event) =>
                  setCandidate(
                    candidates.find(
                      (item) =>
                        `${item.source.messageId}:${item.source.blockId}:${item.source.sha256}` ===
                        event.target.value,
                    ) ?? null,
                  )
                }
              >
                {candidates.map((item) => (
                  <option
                    key={`${item.source.messageId}:${item.source.blockId}`}
                    value={`${item.source.messageId}:${item.source.blockId}:${item.source.sha256}`}
                  >
                    {item.content.slice(0, 80)}
                  </option>
                ))}
              </select>
            </label>
            {candidate && (
              <TextBubble content={candidate.content} artifactSessionId={props.sessionId} />
            )}
            <label>
              Output title
              <input
                value={title}
                maxLength={160}
                disabled={registerBusy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {registerError && <p role="alert">{registerError}</p>}
            <button
              className="home-secondary"
              type="button"
              disabled={!candidate || !title.trim() || registerBusy}
              onClick={() => void register()}
            >
              {registerBusy ? 'Keeping draft…' : 'Keep selected draft'}
            </button>
          </div>
        </HomeDialog>
      )}
      {adding && selected && (
        <AddContributor
          selected={selected}
          onAdd={props.onAdd}
          accountIds={props.eligibility.accountIds}
          available={enabled}
          accessReason={props.eligibility.reason}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}
