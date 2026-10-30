import type { MessageSnapshot, SnapshotBlock } from '@mitzo/protocol';

interface ToolInput {
  name: string;
  id: string;
  inputBuf: string;
}

interface StreamBlock {
  blockId: string;
  snapshot?: SnapshotBlock;
  tool?: ToolInput;
}

/** Owns one message's block identities, reconnect projection and completion.
 * Array order is for serialization; updates address the same blocks by index.
 * No session lookup, authorization, persistence or delivery belongs here. */
export class MessageStreamState {
  private current: MessageSnapshot | null = null;
  private readonly blocks = new Map<number, StreamBlock>();
  private readonly open = new Set<StreamBlock>();

  get messageId(): string | null {
    return this.current?.messageId ?? null;
  }
  get openBlockCount(): number {
    return this.open.size;
  }

  begin(messageId: string): MessageSnapshot {
    this.clear();
    this.current = { messageId, blocks: [] };
    return this.current;
  }

  start(
    index: number,
    blockId: string,
    type: string | undefined,
    tool?: Omit<ToolInput, 'inputBuf'>,
  ): StreamBlock {
    const snapshot: SnapshotBlock | undefined =
      type === 'text' || type === 'thinking' || type === 'redacted_thinking' || type === 'tool_use'
        ? {
            blockId,
            blockType: type,
            content: '',
            done: false,
            ...(tool ? { toolName: tool.name, toolId: tool.id } : {}),
          }
        : undefined;
    const block: StreamBlock = {
      blockId,
      snapshot,
      ...(tool ? { tool: { ...tool, inputBuf: '' } } : {}),
    };
    this.blocks.set(index, block);
    this.open.add(block);
    if (snapshot) this.current?.blocks.push(snapshot);
    return block;
  }

  get(index: number): StreamBlock | undefined {
    return this.blocks.get(index);
  }

  close(index: number): StreamBlock | undefined {
    const block = this.blocks.get(index);
    return block && this.finish(block);
  }

  private finish(block: StreamBlock): StreamBlock | undefined {
    if (!this.open.delete(block)) return;
    if (block.snapshot) block.snapshot.done = true;
    const closed = { ...block };
    // Keep the indexed snapshot for late deltas; release completed input text.
    block.tool = undefined;
    return closed;
  }

  *closeOpen(): Iterable<StreamBlock> {
    for (const block of this.open) yield this.finish(block)!;
  }

  clear(): void {
    this.current = null;
    this.blocks.clear();
    this.open.clear();
  }
}
