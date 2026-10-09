import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import type { WorkspaceSummary } from '../types/workspace';
import { getPreferredModel } from '../lib/model-preference';

export function BriefingMinionPicker({
  name,
  onCancel,
  onUse,
}: {
  name: string;
  onCancel: () => void;
  onUse: (selection: AccountSelection) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current!;
    dialog.showModal?.();
    return () => {
      dialog.close?.();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="briefing-minion-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
    >
      <h2 id={titleId}>Chat with {name}</h2>
      <p className="workspace-muted">
        Choose the account and model for this briefing. A different selection starts a separate
        conversation.
      </p>
      <div className="briefing-minion-picker">
        <AccountModelPicker
          sessionId={null}
          preferredModel={getPreferredModel()}
          onChange={setSelection}
          onSummaryChange={setSummary}
          draftOnly
          disabled={saving}
        />
      </div>
      {summary && (
        <p className="workspace-muted">
          {summary.profile} · {summary.model}
          {summary.thinking ? ` · ${summary.thinking}` : ''}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="briefing-actions">
        <button disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button
          disabled={!selection?.accountId || saving}
          onClick={async () => {
            if (!selection?.accountId) return;
            setSaving(true);
            setError('');
            try {
              await onUse(selection);
            } catch {
              setError('Could not open this briefing conversation. Retry.');
              setSaving(false);
            }
          }}
        >
          {saving ? 'Opening…' : 'Use selection'}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
