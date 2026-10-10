import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { BriefingSnapshot } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { briefingSource } from '../lib/briefing';
import { BriefingMinionPicker } from './BriefingMinionPicker';
import type { AccountSelection } from './AccountModelPicker';
import '../styles/briefing.css';

export function BriefingChatBanner({
  name,
  source,
  registrationError,
  retryRegistration,
  lookupError,
  retryLookup,
  lookupLoading,
  initialSelection,
}: {
  initialSelection?: AccountSelection;
  name: string;
  source: { date: string; revision: string } | null | undefined;
  registrationError?: string;
  retryRegistration?: () => void;
  lookupError?: string;
  retryLookup?: () => void;
  lookupLoading?: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const navigate = useNavigate();
  const stage = useMitzoStore((store) => store.setPendingSession);
  const launch = useMitzoStore((store) => store.pendingSession);
  const messages = useMitzoStore((store) => store.messages.messages);
  if (!source && !registrationError && !lookupError) return null;
  async function changeSelection(selection: AccountSelection) {
    if (!source || !selection.accountId) return;
    const response = await apiFetch(
      `/api/home/briefing-chats?date=${source.date}&revision=${source.revision}`,
    );
    if (!response.ok) throw new Error('Could not find saved conversation');
    const saved: { accountId: string; model: string; sessionId: string }[] = await response.json();
    const existing = saved.find(
      (entry) => entry.accountId === selection.accountId && entry.model === selection.model,
    );
    if (existing) {
      setPicker(false);
      navigate(`/chat/${encodeURIComponent(existing.sessionId)}`);
      return;
    }
    let captured = [
      ...(launch?.sourceSnapshots ?? []),
      ...messages.flatMap((message) => message.sourceSnapshots ?? []),
    ].find(
      (entry) =>
        entry.kind === 'briefing' &&
        entry.date === source.date &&
        entry.revision === source.revision,
    );
    if (!captured) {
      const report = await apiFetch(`/api/home/briefing?date=${source.date}`);
      if (!report.ok) throw new Error('Original source unavailable');
      const snapshot: BriefingSnapshot = await report.json();
      if (snapshot.revision !== source.revision)
        throw new Error(
          'This briefing has changed; open the new report to start a new conversation.',
        );
      captured = briefingSource(snapshot);
    }
    stage({
      prompt:
        'Help me explore this saved morning briefing. Start with its calendar changes and main preparation points.',
      context: `Morning briefing · ${source.date}`,
      sourceSnapshots: [captured],
      briefing: source,
      accountSelection: { ...selection, accountId: selection.accountId },
    });
    setPicker(false);
    navigate('/chat');
  }
  return (
    <aside className="briefing-chat-banner">
      {source && (
        <>
          <span>
            {name} · {source.date}
          </span>
          <Link to={`/briefings/${source.date}?revision=${encodeURIComponent(source.revision)}`}>
            Read briefing
          </Link>
          <button disabled={lookupLoading || !!lookupError} onClick={() => setPicker(true)}>
            Change account or model
          </button>
        </>
      )}
      {lookupError && (
        <p role="alert" className="briefing-lookup-error">
          {lookupError}{' '}
          <button disabled={lookupLoading} onClick={retryLookup}>
            Retry briefing lookup
          </button>
        </p>
      )}
      {registrationError && (
        <p role="alert">
          {registrationError}{' '}
          <button onClick={retryRegistration}>Retry saving briefing link</button>
        </p>
      )}
      {picker && (
        <BriefingMinionPicker
          name={name}
          initialSelection={initialSelection}
          onCancel={() => setPicker(false)}
          onUse={changeSelection}
        />
      )}
    </aside>
  );
}
