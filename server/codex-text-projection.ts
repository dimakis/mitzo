type TextKind = 'text' | 'thinking';
interface TextIdentity {
  kind: TextKind;
  providerTurnId?: string;
}
interface ActiveText extends TextIdentity {
  id: string;
  text: string;
  replayOffset?: number;
}

/** One renderer message is active at a time. Retained identities reject duplicate
 * and substituted items; they never retain completed bodies or participate in
 * flush/reconnect traversal. This is projection state, not execution authority. */
export class CodexTextProjection {
  private readonly identities = new Map<string, TextIdentity>();
  private active?: ActiveText;
  private replaying = false;

  constructor(
    private readonly sink: {
      start(kind: TextKind, providerTurnId?: string): void;
      delta(kind: TextKind, text: string): void;
      complete(kind: TextKind, text: string): void;
    },
    private readonly requireExactTurnIdentity = false,
  ) {}

  private start(id: string, kind: TextKind, providerTurnId: unknown): ActiveText | undefined {
    if (this.requireExactTurnIdentity && (typeof providerTurnId !== 'string' || !providerTurnId))
      return;
    const retained = this.identities.get(id);
    if (retained) {
      if (
        this.requireExactTurnIdentity &&
        (retained.kind !== kind || retained.providerTurnId !== providerTurnId)
      )
        return;
      return this.active?.id === id ? this.active : undefined;
    }
    this.flush();
    const identity: TextIdentity = {
      kind,
      ...(typeof providerTurnId === 'string' ? { providerTurnId } : {}),
    };
    this.identities.set(id, identity);
    const item: ActiveText = { ...identity, id, text: '' };
    this.active = item;
    this.sink.start(kind, identity.providerTurnId);
    return item;
  }

  delta(id: string, kind: TextKind, delta: string, providerTurnId: unknown): void {
    const item = this.start(id, kind, providerTurnId);
    if (!item) return;
    if (kind === 'thinking' && item.replayOffset !== undefined) {
      const offset = item.replayOffset;
      if (item.text.slice(offset, offset + delta.length) === delta) {
        const next = offset + delta.length;
        item.replayOffset = next >= item.text.length ? undefined : next;
        return;
      }
      item.replayOffset = undefined;
    }
    item.text += delta;
    this.sink.delta(kind, delta);
  }

  complete(id: string, kind: TextKind, text: string, providerTurnId: unknown): void {
    const item = this.start(id, kind, providerTurnId);
    if (!item) return;
    const suffix =
      kind === 'thinking'
        ? text.startsWith(item.text)
          ? text.slice(item.text.length)
          : ''
        : !item.text
          ? text
          : '';
    if (suffix) {
      item.text += suffix;
      this.sink.delta(kind, suffix);
    }
    this.flush();
  }

  beginReconnectReplay(): void {
    this.replaying = true;
  }

  beginReasoningReplay(itemId: string): void {
    if (this.replaying && this.active?.id.startsWith(`reasoning:${itemId}:`)) {
      this.active.replayOffset = 0;
    }
  }

  endTurn(): void {
    this.replaying = false;
    this.flush();
  }

  flush(): void {
    const item = this.active;
    if (!item) return;
    this.active = undefined;
    this.sink.complete(item.kind, item.text);
  }
}
