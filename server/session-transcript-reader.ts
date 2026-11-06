import { isAbsolute } from 'node:path';
import type { EventStore, StoredEvent } from './event-store.js';
import {
  reconstructMessages,
  replayEventsToMessages,
  replayEventsToTranscript,
  type RawSdkMessage,
} from './conversation-transcript.js';
import { restoreOwnedVertexInitialPrompt } from './ordinary-local-vertex-replay.js';
import {
  annotateTranscriptAge,
  observeTranscriptAsync,
  observeTranscriptSync,
} from './transcript-observation.js';

interface Dependencies {
  store: Pick<
    EventStore,
    | 'getSession'
    | 'getSessionEvents'
    | 'getSessionEventsThroughCursor'
    | 'getOrdinaryLocalVertexCustody'
    | 'getSendCommand'
    | 'upsertSession'
  >;
  getSessionDirs(): Promise<string[]>;
  getSessionInfo(sessionId: string, dir: string): Promise<{ cwd?: string } | null | undefined>;
  getLegacyMessages(sessionId: string, dir: string): Promise<RawSdkMessage[]>;
  onLegacyParseError(sessionId: string, error: unknown): void;
}

/** One durable prefix per read. The store retains ownership, decoding and cursor semantics. */
export function createSessionTranscriptReader(read: Dependencies) {
  const { store } = read;
  const sessionFor = (sessionId: string) => {
    const session = store.getSession(sessionId);
    annotateTranscriptAge(session?.createdAt);
    return session;
  };
  const eventsFor = (sessionId: string, cursor?: number) =>
    observeTranscriptSync('events_read', (observation) => {
      const events =
        cursor === undefined
          ? store.getSessionEvents(sessionId)
          : store.getSessionEventsThroughCursor(sessionId, cursor);
      observation.annotate({ 'transcript.events_count': events.length });
      return events;
    });
  const recoverWorkspace = async (sessionId: string, dirs?: string[]) => {
    const session = store.getSession(sessionId);
    if (session?.cwd) return;
    const provider = session?.accountBinding?.provider;
    if (provider && provider !== 'anthropic-vertex') return;
    for (const dir of dirs ?? (await read.getSessionDirs())) {
      try {
        const info = await read.getSessionInfo(sessionId, dir);
        if (typeof info?.cwd !== 'string' || !isAbsolute(info.cwd)) continue;
        const current = store.getSession(sessionId);
        if (!current?.cwd)
          store.upsertSession({
            sessionId,
            cwd: info.cwd,
            ...(current?.updatedAt !== undefined ? { updatedAt: current.updatedAt } : {}),
          });
        return;
      } catch {
        /* A missing legacy workspace must not prevent history reads. */
      }
    }
  };
  const projection = (sessionId: string, events: StoredEvent[]) => {
    const session = store.getSession(sessionId);
    if (session?.accountBinding?.provider !== 'anthropic-vertex')
      return { events, initialPrompt: session?.initialPrompt ?? undefined };
    const custody = store.getOrdinaryLocalVertexCustody(sessionId);
    const command = custody ? store.getSendCommand(custody.initialCommandId) : undefined;
    return restoreOwnedVertexInitialPrompt(
      events,
      session?.initialPrompt ?? undefined,
      custody && command?.sessionId === sessionId && typeof command.payload.text === 'string'
        ? { sessionId, commandId: custody.initialCommandId, text: command.payload.text }
        : undefined,
    );
  };
  const project = <T>(
    sessionId: string,
    events: StoredEvent[],
    work: (events: StoredEvent[], initialPrompt?: string) => T,
  ) =>
    observeTranscriptSync('projection', () => {
      const selected = projection(sessionId, events);
      return work(selected.events, selected.initialPrompt);
    });
  const legacyMessages = (sessionId: string) =>
    observeTranscriptAsync('legacy_read', async () => {
      let messages: RawSdkMessage[] = [];
      const directories = [
        ...new Set(
          [store.getSession(sessionId)?.cwd, ...(await read.getSessionDirs())].filter(
            (dir): dir is string => Boolean(dir),
          ),
        ),
      ];
      for (const dir of directories) {
        try {
          messages = await read.getLegacyMessages(sessionId, dir);
          if (messages.length) {
            await recoverWorkspace(sessionId, [dir]);
            break;
          }
        } catch {
          /* Preserve the existing legacy search across configured projects. */
        }
      }
      try {
        return observeTranscriptSync('projection', () => reconstructMessages(messages));
      } catch (error) {
        read.onLegacyParseError(sessionId, error);
        return [];
      }
    });
  return {
    async getMessages(sessionId: string, cursor?: number) {
      if (!sessionFor(sessionId)) return [];
      const events = eventsFor(sessionId, cursor);
      if (!events.length) return cursor === undefined ? legacyMessages(sessionId) : [];
      if (cursor === undefined)
        await observeTranscriptAsync('workspace_recovery', () => recoverWorkspace(sessionId));
      return project(sessionId, events, replayEventsToMessages);
    },
    getReconnectTranscript(sessionId: string, cursor: number) {
      if (!sessionFor(sessionId)) return { messages: [], current: null, currents: [] };
      return project(sessionId, eventsFor(sessionId, cursor), replayEventsToTranscript);
    },
    async getSessionTranscript(sessionId: string) {
      if (!sessionFor(sessionId)) return { messages: [], current: null, currents: [], cursor: 0 };
      const events = eventsFor(sessionId);
      // Already observed an empty prefix: do not call getMessages and query it again.
      if (!events.length)
        return {
          messages: await legacyMessages(sessionId),
          current: null,
          currents: [],
          cursor: 0,
        };
      await observeTranscriptAsync('workspace_recovery', () => recoverWorkspace(sessionId));
      return {
        ...project(sessionId, events, replayEventsToTranscript),
        cursor: events[events.length - 1].seq,
      };
    },
  };
}
