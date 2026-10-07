import { SeatLabel } from './SeatLabel';
import { useRef, useState } from 'react';

export function SymposiumAudienceComposer({
  audience,
  audienceLabel,
  recipients,
  enabled,
  disabledReason,
  onQueue,
  seats = [],
  onSelectRecipient,
}: {
  audience: string;
  audienceLabel: string;
  recipients: string[];
  enabled: boolean;
  disabledReason?: string;
  seats?: { id: string; name: string; role?: string }[];
  onSelectRecipient?(seatId: string): void;
  onQueue: (recipientSeatIds: string[], content: string) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLElement>(null);
  const value = drafts[audience] ?? '';
  const canQueue =
    audience !== 'all' &&
    enabled &&
    recipients.length === 1 &&
    recipients[0] === audience &&
    value.trim().length > 0 &&
    !busy &&
    pickerFor !== audience;
  const mention = /(?:^|\s)@([\w-]*)$/.exec(value);
  const query = pickerFor === audience ? (mention?.[1] ?? '').toLowerCase() : null;
  const matches =
    query === null
      ? []
      : seats.filter(
          (seat) =>
            seat.name.toLowerCase().includes(query) || seat.id.toLowerCase().includes(query),
        );
  function chooseRecipient(seatId: string) {
    if (!seats.some((seat) => seat.id === seatId) || !onSelectRecipient) return;
    if (mention)
      setDrafts((current) => ({ ...current, [audience]: value.slice(0, value.lastIndexOf('@')) }));
    setPickerFor(null);
    onSelectRecipient(seatId);
    input.current?.focus();
  }
  async function queue() {
    if (!canQueue) return;
    setBusy(true);
    setError('');
    try {
      const sent = await onQueue([audience], value.trim());
      if (sent) setDrafts((current) => ({ ...current, [audience]: '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue message');
    } finally {
      setBusy(false);
    }
  }
  if (audience === 'all')
    return (
      <p className="symposium-boundary-note">
        All is a combined timeline. Select an agent stream to write to that agent.
      </p>
    );
  return (
    <form
      className="symposium-audience-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void queue();
      }}
    >
      <label htmlFor="symposium-audience-text">Message for {audienceLabel}</label>
      {onSelectRecipient && (
        <button
          type="button"
          aria-label="Choose agent recipient"
          aria-expanded={pickerFor === audience}
          onClick={() => setPickerFor(pickerFor === audience ? null : audience)}
        >
          @ Switch agent
        </button>
      )}
      {pickerFor === audience && onSelectRecipient && (
        <section ref={picker} className="symposium-recipient-picker" aria-label="Agent recipients">
          <p>Switch streams; drafts stay with their agent.</p>
          {matches.map((seat) => (
            <button type="button" key={seat.id} onClick={() => chooseRecipient(seat.id)}>
              <SeatLabel seatId={seat.id} name={seat.name} />
              {seat.role && ` · ${seat.role}`}
              {seats.filter((candidate) => candidate.name.toLowerCase() === seat.name.toLowerCase())
                .length > 1 && ` · ${seat.id.slice(-6)}`}
            </button>
          ))}
          {matches.length === 0 && <p>No matching agent.</p>}
          <button
            type="button"
            onClick={() => {
              setPickerFor(null);
              input.current?.focus();
            }}
          >
            Close recipient picker
          </button>
        </section>
      )}
      <textarea
        ref={input}
        id="symposium-audience-text"
        aria-label={`Message for ${audienceLabel}`}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setDrafts((current) => ({ ...current, [audience]: next }));
          setPickerFor(onSelectRecipient && /(?:^|\s)@[\w-]*$/.test(next) ? audience : null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPickerFor(null);
          if (event.key === 'ArrowDown' && pickerFor === audience) {
            event.preventDefault();
            picker.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
        placeholder={`Ask ${audienceLabel} an aside…`}
      />
      <button type="submit" disabled={!canQueue}>
        Queue for approval
      </button>
      {!enabled && (
        <span role="status">
          {disabledReason ?? 'Provider admission is pending. Your draft stays here.'}
        </span>
      )}
      {error && <span role="alert">{error}</span>}
    </form>
  );
}
