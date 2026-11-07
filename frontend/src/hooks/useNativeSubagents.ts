import { useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import {
  NativeSubagentStreamEventSchema,
  NativeSubagentSnapshotSchema,
  type NativeSubagentControl,
  type NativeSubagentControlStatus,
  type NativeSubagentSnapshot,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { readEventStream } from '../lib/event-stream';

interface State {
  agents: NativeSubagentSnapshot[];
  available: boolean;
  error?: string;
}
/** One authenticated stream per conversation, shared by all of its turn rows. */
class NativeSubagentFeed {
  private state: State = { agents: [], available: false };
  private listeners = new Set<() => void>();
  private abort?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  constructor(private sessionId: string) {}
  snapshot = () => this.state;
  private update(state: State) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private stop = () => {
    clearTimeout(this.retry);
    this.abort?.abort();
    this.abort = undefined;
  };
  private authLost = () => {
    this.stop();
    this.update({ agents: [], available: false, error: 'Sign in again to inspect subagents.' });
  };
  reconnect = () => {
    if (this.listeners.size) void this.connect();
  };
  private visible = () => {
    if (document.visibilityState === 'visible') this.reconnect();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      window.addEventListener(AUTH_LOST_EVENT, this.authLost);
      window.addEventListener(AUTH_RESTORED_EVENT, this.reconnect);
      window.addEventListener('online', this.reconnect);
      document.addEventListener('visibilitychange', this.visible);
      void this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stop();
        window.removeEventListener(AUTH_LOST_EVENT, this.authLost);
        window.removeEventListener(AUTH_RESTORED_EVENT, this.reconnect);
        window.removeEventListener('online', this.reconnect);
        document.removeEventListener('visibilitychange', this.visible);
        this.state = { agents: [], available: false };
      }
    };
  };
  private async connect() {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    let available = true;
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/codex-subagents/events`,
        { signal: abort.signal },
      );
      if (!response.ok || !response.body) throw Error('Subagent activity unavailable');
      for await (const raw of readEventStream(response.body)) {
        if (abort.signal.aborted || this.abort !== abort) return;
        const value = NativeSubagentStreamEventSchema.parse(raw);
        if (value.type === 'reset') {
          available = value.available;
          this.update({ agents: [], available });
        } else if (value.type === 'status') {
          available = value.available;
          this.update({ ...this.state, available });
        } else {
          const found = this.state.agents.some((agent) => agent.threadId === value.agent.threadId);
          this.update({
            ...this.state,
            agents: found
              ? this.state.agents.map((agent) =>
                  agent.threadId === value.agent.threadId ? value.agent : agent,
                )
              : [...this.state.agents, value.agent],
          });
        }
      }
      if (!abort.signal.aborted) throw Error('Activity disconnected');
    } catch {
      if (abort.signal.aborted || this.abort !== abort) return;
      this.update({
        agents: this.state.agents,
        available: false,
        error: 'Live subagent activity is unavailable. Saved output is retained.',
      });
      if (this.listeners.size)
        this.retry = setTimeout(() => void this.connect(), available ? 1500 : 30000);
    }
  }
  inspect = async (threadId: string): Promise<void> => {
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/codex-subagents/inspect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw Error('Inspection unavailable');
      const { agent } = z
        .object({ agent: NativeSubagentSnapshotSchema })
        .parse(await response.json());
      if (agent.threadId !== threadId) throw Error('Inspection identity changed');
      this.update({
        ...this.state,
        error: undefined,
        agents: this.state.agents.map((previous) =>
          previous.threadId === threadId && previous.revision <= agent.revision ? agent : previous,
        ),
      });
    } catch {
      this.update({
        ...this.state,
        error:
          'Subagent inspection is unavailable. Reconnect the original chat runtime and try again.',
      });
    }
  };
  control = async (input: NativeSubagentControl): Promise<NativeSubagentControlStatus> => {
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/codex-subagents/control`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) return 'uncertain';
      return z
        .object({
          requestId: z.literal(input.requestId),
          status: z.enum(['accepted', 'rejected', 'uncertain']),
        })
        .parse(await response.json()).status;
    } catch {
      return 'uncertain';
    }
  };
}
const feeds = new Map<string, NativeSubagentFeed>();
export function useNativeSubagents(sessionId: string) {
  const feed = useMemo(() => {
    let value = feeds.get(sessionId);
    if (!value) {
      value = new NativeSubagentFeed(sessionId);
      feeds.set(sessionId, value);
    }
    return value;
  }, [sessionId]);
  const state = useSyncExternalStore(feed.subscribe, feed.snapshot, feed.snapshot);
  return { ...state, reconnect: feed.reconnect, inspect: feed.inspect, control: feed.control };
}
