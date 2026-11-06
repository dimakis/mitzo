import type { SessionActivity } from '@mitzo/protocol';

type Timing = Pick<SessionActivity, 'turnStartedAt' | 'lastMessageAt' | 'completedAt' | 'phase'> & {
  lastEventAt?: number;
};
type Entry = { timing: Timing; textMessage?: unknown; state?: string; stateChangedAt?: number };

/** Bounded per-live-session observations. Never retain text, arguments or results. */
export class SessionActivityEvents {
  private entries = new Map<string, Entry>();
  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, (entry = { timing: {} }));
    return entry;
  }
  get(id: string): Timing {
    return this.entries.get(id)?.timing ?? {};
  }
  start(id: string): void {
    const entry = this.entry(id);
    entry.timing = {
      lastMessageAt: entry.timing.lastMessageAt,
      turnStartedAt: Date.now(),
      lastEventAt: Date.now(),
      phase: 'thinking',
    };
    entry.textMessage = undefined;
  }
  finish(id: string): void {
    const timing = this.entry(id).timing;
    timing.completedAt = timing.lastEventAt = Date.now();
    timing.phase = undefined;
  }
  message(id: string): void {
    this.entry(id).timing.lastMessageAt = Date.now();
  }
  state(id: string, state: string): number | undefined {
    const entry = this.entry(id);
    if (entry.state !== undefined && entry.state !== state) entry.stateChangedAt = Date.now();
    entry.state = state;
    return entry.stateChangedAt;
  }
  observe(id: string, event: Readonly<Record<string, unknown>>): boolean {
    if (!['block_start', 'tool_result', 'message_end'].includes(String(event.type))) return false;
    const entry = this.entry(id),
      timing = entry.timing;
    if (event.type === 'block_start') {
      if (event.blockType === 'text') {
        if (entry.textMessage !== event.messageId) timing.lastMessageAt = Date.now();
        entry.textMessage = event.messageId;
        timing.phase = 'reply';
      } else if (event.blockType === 'tool_use') {
        const name =
          String(event.toolName ?? '')
            .split('__')
            .at(-1) ?? '';
        timing.phase = /^(Read|Glob|Grep|read_file|list_dir|search)$/i.test(name)
          ? 'reading'
          : /^(Edit|Write|apply_patch|write_file)$/i.test(name)
            ? 'editing'
            : /^(Bash|exec_command|shell|write_stdin)$/i.test(name)
              ? 'command'
              : 'tool';
      } else timing.phase = 'thinking';
    } else if (event.type === 'tool_result') timing.phase = 'thinking';
    else if (entry.textMessage !== undefined && entry.textMessage === event.messageId) {
      timing.lastMessageAt = Date.now();
      entry.textMessage = undefined;
    }
    timing.lastEventAt = Date.now();
    return true;
  }
  forget(id: string): void {
    this.entries.delete(id);
  }
  clear(): void {
    this.entries.clear();
  }
}

type Observer = (clientId: string, event: Readonly<Record<string, unknown>>) => void;
let observer: Observer | undefined;
export function setSessionActivityObserver(value: Observer): void {
  observer = value;
}
export function observeSessionActivity(
  clientId: string,
  event: Readonly<Record<string, unknown>>,
): void {
  if (!['block_start', 'tool_result', 'message_end'].includes(String(event.type))) return;
  // Presentation must never prevent durable delivery or execution cleanup.
  try {
    observer?.(clientId, event);
  } catch {
    /* Best-effort overview only. */
  }
}
