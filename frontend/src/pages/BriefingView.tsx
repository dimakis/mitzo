import { localBriefingConversation } from '../lib/briefing-registration';
import { UiIcon } from '../components/UiIcon';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { BriefingSnapshot } from '@mitzo/protocol';
import ReactMarkdown from 'react-markdown';
import {
  remarkPlugins,
  rehypePlugins,
  artifactMarkdownComponents,
  artifactUrlTransform,
} from '../lib/markdown-config';
import { apiFetch } from '../lib/api-fetch';
import { briefingSource, parseBriefing, type BriefingSection } from '../lib/briefing';
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

function BriefingMarkdown({ content, sourcePath }: { content: string; sourcePath: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const components = artifactMarkdownComponents(
    sourcePath,
    undefined,
    location.pathname + location.search,
    navigate,
  );
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={artifactUrlTransform}
      components={{
        ...components,
        h1: ({ children }) => <p className="briefing-captured-title workspace-muted">{children}</p>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
function containsMeeting(section: BriefingSection): boolean {
  return section.children.some((child) => child.kind === 'meeting' || containsMeeting(child));
}
function Section({
  section,
  expanded,
  sourcePath,
}: {
  section: BriefingSection;
  expanded: boolean;
  sourcePath: string;
}) {
  const container = section.kind === 'source' && containsMeeting(section);
  return (
    <details className={`briefing-section briefing-${section.kind}`} open={expanded || container}>
      <summary>
        <UiIcon name="forward" size={16} />
        {section.title}
      </summary>
      <div className="briefing-source">
        <BriefingMarkdown content={section.body} sourcePath={sourcePath} />
      </div>
      {section.children.map((child, index) => (
        <Section
          key={index}
          section={child}
          sourcePath={sourcePath}
          expanded={expanded && child.kind !== 'jira'}
        />
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
  const [bulkAction, setBulkAction] = useState(0);
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
    const retained = await localBriefingConversation(snapshot, selection);
    if (retained) {
      navigate(`/chat/${encodeURIComponent(retained)}`);
      return;
    }
    stageLaunch({
      prompt:
        'Help me explore this saved morning briefing. Start with the calendar changes and the main preparation points. Keep participant Jira as supporting context; let me choose what to investigate further.',
      context: `Morning briefing · ${snapshot.date}`,
      sourceSnapshots: [briefingSource(snapshot)],
      accountSelection: { ...selection, accountId: selection.accountId },
      briefing: { date: snapshot.date, revision: snapshot.revision },
    });
    navigate('/chat');
  }
  return (
    <main className="briefing-page workspace-page">
      <Link to="/">
        <UiIcon name="back" size={16} /> Today
      </Link>
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
            <button
              onClick={() => {
                setExpanded(true);
                setBulkAction((value) => value + 1);
              }}
            >
              Expand all meetings
            </button>
            <button
              onClick={() => {
                setExpanded(false);
                setBulkAction((value) => value + 1);
              }}
            >
              Collapse all
            </button>
            <Link to="/calendar">Open calendar</Link>
          </div>
          <div className="briefing-source">
            <BriefingMarkdown content={outline.body} sourcePath={snapshot.path} />
          </div>
          {outline.children.map((section, index) => (
            <Section
              key={`${snapshot.revision}:${index}:${bulkAction}`}
              section={section}
              sourcePath={snapshot.path}
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
