import { useState } from 'react';

export function SymposiumAudienceComposer({
  audience,
  audienceLabel,
  recipients,
  enabled,
  onQueue,
}: {
  audience: string;
  audienceLabel: string;
  recipients: string[];
  enabled: boolean;
  onQueue: (recipientSeatIds: string[], content: string) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const value = drafts[audience] ?? '';
  const canQueue = enabled && recipients.length > 0 && value.trim().length > 0 && !busy;
  async function queue() {
    if (!canQueue) return;
    setBusy(true);
    setError('');
    try {
      const sent = await onQueue(recipients, value.trim());
      if (sent) setDrafts((current) => ({ ...current, [audience]: '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue message');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="symposium-audience-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void queue();
      }}
    >
      <label htmlFor="symposium-audience-text">Message for {audienceLabel}</label>
      <textarea
        id="symposium-audience-text"
        aria-label={`Message for ${audienceLabel}`}
        value={value}
        onChange={(event) =>
          setDrafts((current) => ({ ...current, [audience]: event.target.value }))
        }
        placeholder={
          audience === 'all' ? 'Write to all admitted seats…' : `Ask ${audienceLabel} an aside…`
        }
      />
      <button type="submit" disabled={!canQueue}>
        Queue for approval
      </button>
      {!enabled && <span role="status">Provider admission is pending. Your draft stays here.</span>}
      {error && <span role="alert">{error}</span>}
    </form>
  );
}
