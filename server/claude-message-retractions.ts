import type { MessageRetraction } from '@mitzo/protocol';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Bounded identities observed by this query loop; never accepts a guessed public ID. */
export class ClaudeMessageRetractions {
  private readonly bindings = new Map<string, MessageRetraction[]>();
  private readonly retracted = new Set<string>();
  private readonly messages = new Set<string>();
  private readonly messageFrames = new Map<string, Set<string>>();
  private readonly incompleteMessages = new Set<string>();

  observe(
    event: Record<string, unknown>,
    sessionId: string,
    currentMessageId: string | null,
    toolOwners: ReadonlyMap<string, string>,
  ): { targets: MessageRetraction[]; unavailable: boolean } {
    const targets: MessageRetraction[] = [];
    if (event.session_id !== sessionId || event.parent_tool_use_id != null)
      return { targets, unavailable: false };
    if (event.type === 'result') {
      this.bindings.clear();
      this.retracted.clear();
      this.messages.clear();
      this.messageFrames.clear();
      this.incompleteMessages.clear();
      return { targets, unavailable: false };
    }
    const message = event.message as Record<string, unknown> | undefined;
    let observed: MessageRetraction[] = [];
    if (
      event.type === 'assistant' &&
      currentMessageId &&
      currentMessageId.length <= 2000 &&
      message?.id === currentMessageId
    ) {
      observed = [{ messageId: currentMessageId }];
      this.messages.add(currentMessageId);
      if (this.messages.size > 512) {
        const oldest = this.messages.values().next().value!;
        this.messages.delete(oldest);
        this.messageFrames.delete(oldest);
        this.incompleteMessages.delete(oldest);
      }
      if (uuid(event.uuid) && !this.incompleteMessages.has(currentMessageId)) {
        const frames = this.messageFrames.get(currentMessageId) ?? new Set<string>();
        frames.add(event.uuid);
        this.messageFrames.set(currentMessageId, frames);
      }
    }
    if (event.type === 'user' && Array.isArray(message?.content)) {
      if (message.content.length > 256) return { targets, unavailable: true };
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
        if (typeof block.tool_use_id !== 'string' || block.tool_use_id.length > 1000) continue;
        const owner = toolOwners.get(block.tool_use_id);
        if (owner && this.messages.has(owner))
          observed.push({ messageId: owner, toolId: block.tool_use_id });
      }
    }
    if (uuid(event.uuid) && observed.length && !this.retracted.has(event.uuid)) {
      const previous = this.bindings.get(event.uuid);
      // Conflicting native identities are unusable, not permission to retract either target.
      if (previous && JSON.stringify(previous) !== JSON.stringify(observed)) {
        for (const target of [...previous, ...observed]) {
          if (target.toolId) continue;
          this.messageFrames.delete(target.messageId);
          this.incompleteMessages.add(target.messageId);
        }
        this.bindings.delete(event.uuid);
        this.retracted.add(event.uuid);
        return { targets, unavailable: true };
      }
      this.bindings.set(event.uuid, observed);
      if (this.bindings.size > 512) {
        const oldest = this.bindings.keys().next().value!;
        for (const target of this.bindings.get(oldest) ?? []) {
          if (target.toolId) continue;
          this.messageFrames.delete(target.messageId);
          if (this.messages.has(target.messageId)) this.incompleteMessages.add(target.messageId);
        }
        this.bindings.delete(oldest);
      }
    }
    const requested =
      event.type === 'assistant'
        ? event.supersedes
        : event.type === 'system' && event.subtype === 'model_refusal_fallback'
          ? event.retracted_message_uuids
          : undefined;
    if (requested === undefined) return { targets, unavailable: false };
    if (!Array.isArray(requested) || requested.length > 256) return { targets, unavailable: true };
    const requestedIds = new Set(requested.filter(uuid));
    let unavailable = false;
    for (const id of requested) {
      if (!uuid(id) || id === event.uuid) {
        unavailable = true;
        continue;
      }
      if (this.retracted.has(id)) continue;
      const known = this.bindings.get(id);
      if (!known) {
        unavailable = true;
        continue;
      }
      // Multiple native wire frames can share one API message ID. A receipt
      // for one fragment cannot erase the rest of that public response.
      if (
        known.some((target) => {
          if (target.toolId) return false;
          const frames = this.messageFrames.get(target.messageId);
          return (
            !frames ||
            [...frames].some((frame) => !requestedIds.has(frame) && !this.retracted.has(frame))
          );
        })
      ) {
        unavailable = true;
        continue;
      }
      targets.push(...known);
      for (const target of known) {
        if (target.toolId) continue;
        for (const frame of this.messageFrames.get(target.messageId) ?? []) {
          this.retracted.add(frame);
          this.bindings.delete(frame);
        }
        this.messageFrames.delete(target.messageId);
        this.incompleteMessages.add(target.messageId);
      }
      this.bindings.delete(id);
      this.retracted.add(id);
      while (this.retracted.size > 512)
        this.retracted.delete(this.retracted.values().next().value!);
    }
    return {
      targets: targets.filter(
        (target, index) =>
          targets.findIndex(
            (other) => other.messageId === target.messageId && other.toolId === target.toolId,
          ) === index,
      ),
      unavailable,
    };
  }
}
