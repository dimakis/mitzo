import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { apiFetch } from '../lib/api-fetch';
import { buildInboxPrompt, buildInboxContext } from '../lib/inbox-utils';
import { CollapsibleSection } from './CollapsibleSection';

interface InboxItem {
  filename: string;
  agent: string;
  title: string;
  tags: string[];
  timestamp: string;
  preview: string;
}

export function InboxSection() {
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);
  const storeInbox = useMitzoStore((s) => s.inbox.items);
  const loadInbox = useMitzoStore((s) => s.loadInbox);

  useEffect(() => {
    loadInbox().then(() => setLoading(false));
  }, [loadInbox]);

  // Sync store inbox to local state, filtering optimistic removals
  useEffect(() => {
    const serverFilenames = new Set((storeInbox as InboxItem[]).map((i) => i.filename));
    setPendingRemovals((prev) => {
      const pruned = new Set<string>();
      for (const f of prev) {
        if (serverFilenames.has(f)) pruned.add(f);
      }
      return pruned.size === prev.size ? prev : pruned;
    });
    const filtered = (storeInbox as InboxItem[]).filter(
      (item) => !pendingRemovals.has(item.filename),
    );
    setItems(filtered);
  }, [storeInbox, pendingRemovals]);

  const handleApprove = useCallback(
    (filename: string) => {
      setPendingRemovals((prev) => new Set(prev).add(filename));
      setItems((prev) => prev.filter((i) => i.filename !== filename));
      apiFetch(`/api/inbox/${encodeURIComponent(filename)}/approve`, { method: 'POST' })
        .then((res) => {
          if (!res.ok) loadInbox();
        })
        .catch(() => loadInbox())
        .finally(() => {
          setPendingRemovals((prev) => {
            const next = new Set(prev);
            next.delete(filename);
            return next;
          });
        });
    },
    [loadInbox],
  );

  const handleDiscard = useCallback(
    (filename: string) => {
      setPendingRemovals((prev) => new Set(prev).add(filename));
      setItems((prev) => prev.filter((i) => i.filename !== filename));
      apiFetch(`/api/inbox/${encodeURIComponent(filename)}`, { method: 'DELETE' })
        .then((res) => {
          if (!res.ok) loadInbox();
        })
        .catch(() => loadInbox())
        .finally(() => {
          setPendingRemovals((prev) => {
            const next = new Set(prev);
            next.delete(filename);
            return next;
          });
        });
    },
    [loadInbox],
  );

  const handleStartSession = useCallback(
    (item: InboxItem) => {
      setPendingSession({
        prompt: buildInboxPrompt(item, item.preview),
        context: buildInboxContext(item, item.preview),
      });
      navigate('/chat');
    },
    [navigate, setPendingSession],
  );

  return (
    <CollapsibleSection title="Inbox" badge={items.length || undefined} storageKey="cc-inbox">
      {loading && <p className="cc-empty">Loading...</p>}
      {!loading && items.length === 0 && <p className="cc-empty">No pending proposals</p>}
      {items.map((item) => (
        <div key={item.filename} className="cc-card cc-card--inbox">
          <div className="cc-card-content">
            <div className="cc-card-title">
              <span className="cc-card-agent">{item.agent}</span> {item.title}
            </div>
            <div className="cc-card-meta">{item.preview}</div>
          </div>
          <div className="cc-card-actions">
            <button
              className="cc-btn cc-btn--approve"
              onClick={() => handleApprove(item.filename)}
              title="Approve"
            >
              &#x2713;
            </button>
            <button
              className="cc-btn cc-btn--danger"
              onClick={() => handleDiscard(item.filename)}
              title="Discard"
            >
              &#x2717;
            </button>
            <button
              className="cc-btn"
              onClick={() => handleStartSession(item)}
              title="Start session"
            >
              &#x25B6;
            </button>
          </div>
        </div>
      ))}
    </CollapsibleSection>
  );
}
