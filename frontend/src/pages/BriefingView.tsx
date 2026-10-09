import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { BriefingSnapshot } from '@mitzo/protocol';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins, markdownComponents } from '../lib/markdown-config';
const briefingMarkdownComponents = {
  ...markdownComponents,
  h1: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
};
import { apiFetch } from '../lib/api-fetch';
import { briefingContext, parseBriefing, type BriefingSection } from '../lib/briefing';
import { useHomePreferences } from '../hooks/useHomePreferences';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { BriefingMinionPicker } from '../components/BriefingMinionPicker';
import type { AccountSelection } from '../components/AccountModelPicker';
import '../styles/briefing.css';

interface SavedChat {
  sessionId: string;
  accountId: string;
  model: string;
}

function Section({ section, expanded }: { section: BriefingSection; expanded: boolean }) {
  return (
    <details className={`briefing-section briefing-${section.kind}`} open={expanded}>
      <summary>{section.title}</summary>
      <div className="briefing-source">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={briefingMarkdownComponents}
        >
          {section.body}
        </ReactMarkdown>
      </div>
      {section.children.map((child, index) => (
        <Section key={index} section={child} expanded={expanded && child.kind !== 'jira'} />
      ))}
    </details>
  );
}

export function BriefingView() {
  const { date = '' } = useParams<{ date: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const stageLaunch = useMitzoStore((store) => store.setPendingSession);
  const { preferences } = useHomePreferences();
  const name = preferences?.names.briefing ?? 'Minion';
  const [loaded, setLoaded] = useState<{ date: string; snapshot: BriefingSnapshot } | null>(null);
  const snapshot = loaded?.date === date ? loaded.snapshot : null;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState(false);
  const [chats, setChats] = useState<SavedChat[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch(`/api/home/briefing?date=${encodeURIComponent(date)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'No saved briefing for this date.'
              : 'Could not read the saved briefing.',
          );
        const data: BriefingSnapshot = await response.json();
        if (
          data.date !== date ||
          typeof data.content !== 'string' ||
          typeof data.revision !== 'string'
        )
          throw new Error('Invalid briefing snapshot.');
        if (!controller.signal.aborted) {
          setLoaded({ date, snapshot: data });
          setError('');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Could not read the saved briefing.');
      });
    return () => controller.abort();
  }, [date, attempt]);
  useEffect(() => {
    if (!snapshot) return;
    const controller = new AbortController();
    setChats([]);
    void apiFetch(`/api/home/briefing-chats?date=${date}&revision=${snapshot.revision}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted && Array.isArray(data)) setChats(data);
      })
      .catch(() => {
        /* The reader remains available when conversation lookup fails. */
      });
    return () => controller.abort();
  }, [date, snapshot]);
  useEffect(() => {
    if (snapshot && searchParams.get('ask') === '1') setPicker(true);
  }, [snapshot, searchParams]);
  const outline = useMemo(() => parseBriefing(snapshot?.content ?? ''), [snapshot]);
  function closePicker() {
    setPicker(false);
    if (searchParams.has('ask')) {
      const next = new URLSearchParams(searchParams);
      next.delete('ask');
      setSearchParams(next, { replace: true });
    }
  }
  async function useSelection(selection: AccountSelection) {
    if (!snapshot || !selection.accountId) return;
    // Refresh at confirmation; another device may already have started this exact conversation.
    const response = await apiFetch(
      `/api/home/briefing-chats?date=${date}&revision=${snapshot.revision}`,
    );
    if (!response.ok) throw new Error('Conversation lookup unavailable');
    const saved: SavedChat[] = await response.json();
    const existing = saved.find(
      (chat) => chat.accountId === selection.accountId && chat.model === selection.model,
    );
    if (existing) {
      navigate(`/chat/${encodeURIComponent(existing.sessionId)}`);
      return;
    }
    stageLaunch({
      prompt:
        'Help me explore this saved morning briefing. Start with the calendar changes and the main preparation points. Keep participant Jira as supporting context; let me choose what to investigate further.',
      context: `Morning briefing · ${snapshot.date}`,
      contextBlocks: [briefingContext(snapshot)],
      accountSelection: { ...selection, accountId: selection.accountId },
      briefing: { date: snapshot.date, revision: snapshot.revision },
    });
    navigate('/chat');
  }
  return (
    <main className="briefing-page workspace-page">
      <Link to="/">← Today</Link>
      <WorkspacePageHeading
        eyebrow={date}
        title="Morning briefing"
        description={
          snapshot
            ? `Saved report · prepared ${new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : undefined
        }
        actions={snapshot && <button onClick={() => setPicker(true)}>Ask {name}</button>}
      />
      {error ? (
        <p role="alert">
          {error}{' '}
          <button
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </p>
      ) : !snapshot ? (
        <p role="status">Loading saved briefing…</p>
      ) : (
        <>
          {searchParams.get('revision') && searchParams.get('revision') !== snapshot.revision && (
            <p role="status" className="workspace-muted">
              This report is newer than the snapshot in your conversation. That conversation keeps
              its original captured context.
            </p>
          )}
          <p className="workspace-muted">
            Assembled by the scheduled briefing job. {name} can help you explore this dated report.
          </p>
          <div className="briefing-actions">
            <button onClick={() => setExpanded(true)}>Expand all meetings</button>
            <button onClick={() => setExpanded(false)}>Collapse all</button>
            <Link to="/calendar">Open calendar</Link>
          </div>
          <div className="briefing-source">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={briefingMarkdownComponents}
            >
              {outline.body}
            </ReactMarkdown>
          </div>
          {outline.children.map((section, index) => (
            <Section
              key={`${snapshot.revision}:${index}:${expanded}`}
              section={section}
              expanded={expanded && section.kind !== 'calendar' && section.kind !== 'jira'}
            />
          ))}
          <details className="briefing-section">
            <summary>Original saved report</summary>
            <pre className="briefing-original">{snapshot.content}</pre>
          </details>
          {chats.length > 0 && (
            <section>
              <h2>Briefing conversations</h2>
              {chats.map((chat) => (
                <p key={chat.sessionId}>
                  <Link to={`/chat/${encodeURIComponent(chat.sessionId)}`}>
                    {name} · {chat.model}
                  </Link>
                </p>
              ))}
            </section>
          )}
        </>
      )}
      {picker && snapshot && (
        <BriefingMinionPicker name={name} onCancel={closePicker} onUse={useSelection} />
      )}
    </main>
  );
}
