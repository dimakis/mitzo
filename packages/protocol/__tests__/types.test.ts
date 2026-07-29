import { describe, it, expect } from 'vitest';
import type {
  MitzoMode,
  BlockType,
  ToolTier,
  RawToolInput,
  SnapshotBlock,
  MessageSnapshot,
  StreamingBlock,
  StreamingMessage,
  FinishedBlock,
  FinishedMessage,
  PermissionRequest,
  ImageAttachment,
  Session,
  StoredEvent,
  SessionMeta,
  SessionType,
  TurnMode,
  InterceptMode,
  SeatConfig,
  TurnRules,
  SymposiumConfig,
} from '../src/types.js';

describe('protocol types', () => {
  it('MitzoMode accepts valid values', () => {
    const modes: MitzoMode[] = ['ask', 'agent', 'auto'];
    expect(modes).toHaveLength(3);
  });

  it('BlockType accepts valid values', () => {
    const types: BlockType[] = ['text', 'thinking', 'redacted_thinking', 'tool_use'];
    expect(types).toHaveLength(4);
  });

  it('ToolTier accepts valid values', () => {
    const tiers: ToolTier[] = ['safe', 'standard', 'elevated', 'unknown'];
    expect(tiers).toHaveLength(4);
  });

  it('RawToolInput — write variant', () => {
    const input: RawToolInput = { type: 'write', path: '/foo.ts', contents: 'hello' };
    expect(input.type).toBe('write');
    expect(input.path).toBe('/foo.ts');
  });

  it('RawToolInput — diff variant', () => {
    const input: RawToolInput = { type: 'diff', path: '/bar.ts', old_string: 'a', new_string: 'b' };
    expect(input.type).toBe('diff');
  });

  it('RawToolInput — command variant', () => {
    const input: RawToolInput = { type: 'command', command: 'ls' };
    expect(input.type).toBe('command');
  });

  it('RawToolInput — read variant', () => {
    const input: RawToolInput = { type: 'read', path: '/src/main.py', language: 'python' };
    expect(input.type).toBe('read');
    expect(input.path).toBe('/src/main.py');
    expect(input.language).toBe('python');
  });

  it('SnapshotBlock has required fields', () => {
    const block: SnapshotBlock = {
      blockId: 'b1',
      blockType: 'text',
      content: 'hello',
      done: false,
    };
    expect(block.blockId).toBe('b1');
    expect(block.done).toBe(false);
  });

  it('SnapshotBlock accepts optional tool fields', () => {
    const block: SnapshotBlock = {
      blockId: 'b2',
      blockType: 'tool_use',
      content: '',
      done: true,
      toolName: 'Read',
      toolId: 't1',
      toolInput: '{}',
      rawInput: { type: 'command', command: 'ls' },
    };
    expect(block.toolName).toBe('Read');
  });

  it('MessageSnapshot has messageId and blocks', () => {
    const snapshot: MessageSnapshot = {
      messageId: 'm1',
      blocks: [{ blockId: 'b1', blockType: 'text', content: 'hi', done: true }],
    };
    expect(snapshot.blocks).toHaveLength(1);
  });

  it('StreamingBlock extends with toolResult', () => {
    const block: StreamingBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      done: false,
      toolResult: 'file contents',
      toolError: false,
    };
    expect(block.toolResult).toBe('file contents');
  });

  it('StreamingMessage uses Map for blocks', () => {
    const msg: StreamingMessage = {
      messageId: 'm1',
      blocks: new Map(),
      blockOrder: [],
    };
    expect(msg.blocks.size).toBe(0);
  });

  it('FinishedMessage has role and blocks array', () => {
    const msg: FinishedMessage = {
      messageId: 'm1',
      role: 'assistant',
      blocks: [{ blockId: 'b1', blockType: 'text', content: 'hi' }],
    };
    expect(msg.role).toBe('assistant');
    expect(msg.blocks).toHaveLength(1);
  });

  it('FinishedMessage user with images and contextBlocks', () => {
    const msg: FinishedMessage = {
      messageId: 'm2',
      role: 'user',
      blocks: [],
      images: ['base64data'],
      contextBlocks: ['block1'],
    };
    expect(msg.images).toHaveLength(1);
    expect(msg.contextBlocks).toHaveLength(1);
  });

  it('PermissionRequest has required and optional fields', () => {
    const req: PermissionRequest = {
      permId: 'p1',
      toolName: 'Bash',
      toolInput: 'rm -rf /',
      tier: 'elevated',
    };
    expect(req.tier).toBe('elevated');
    expect(req.title).toBeUndefined();
  });

  it('ImageAttachment has data, mediaType, preview', () => {
    const img: ImageAttachment = { data: 'abc', mediaType: 'image/png', preview: 'thumb' };
    expect(img.mediaType).toBe('image/png');
  });

  it('Session has required fields', () => {
    const session: Session = { id: 's1', summary: 'test', lastModified: Date.now() };
    expect(session.id).toBe('s1');
  });

  it('Session has optional fields', () => {
    const session: Session = {
      id: 's2',
      summary: 'test',
      lastModified: Date.now(),
      branch: 'main',
      isActive: true,
      isAttached: false,
      totalTokens: 1000,
      numTurns: 5,
    };
    expect(session.isActive).toBe(true);
  });

  it('StoredEvent has correct shape', () => {
    const event: StoredEvent = {
      seq: 1,
      sessionId: 's1',
      type: 'message_start',
      payload: { messageId: 'm1' },
      createdAt: Date.now(),
    };
    expect(event.seq).toBe(1);
  });

  it('SessionMeta has all tracking fields', () => {
    const meta: SessionMeta = {
      sessionId: 's1',
      summary: 'test session',
      branch: 'main',
      cwd: '/home',
      mode: 'agent',
      isActive: true,
      isHidden: false,
      promptCount: 3,
      manuallyRenamed: false,
      initialPrompt: 'hello',
      wtId: null,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      totalCostUsd: 0.01,
      numTurns: 2,
      durationMs: 5000,
      durationApiMs: 3000,
      goalId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(meta.promptCount).toBe(3);
    expect(meta.totalCostUsd).toBe(0.01);
  });

  // --- Symposium types ---

  it('SessionType accepts valid values', () => {
    const types: SessionType[] = ['chat', 'symposium'];
    expect(types).toHaveLength(2);
  });

  it('TurnMode accepts valid values', () => {
    const modes: TurnMode[] = ['round-robin', 'directed', 'budgeted'];
    expect(modes).toHaveLength(3);
  });

  it('InterceptMode accepts valid values', () => {
    const modes: InterceptMode[] = ['auto', 'manual'];
    expect(modes).toHaveLength(2);
  });

  it('SeatConfig has required fields', () => {
    const seat: SeatConfig = {
      name: 'Architect',
      model: 'claude-opus-4-6',
      systemPrompt: 'You are a senior architect.',
      color: '#3B82F6',
    };
    expect(seat.name).toBe('Architect');
    expect(seat.model).toBe('claude-opus-4-6');
  });

  it('TurnRules has required fields and optional budgetUsd', () => {
    const rules: TurnRules = {
      mode: 'round-robin',
      maxTurns: 10,
    };
    expect(rules.mode).toBe('round-robin');
    expect(rules.budgetUsd).toBeUndefined();

    const budgeted: TurnRules = {
      mode: 'budgeted',
      maxTurns: 20,
      budgetUsd: 2.0,
    };
    expect(budgeted.budgetUsd).toBe(2.0);
  });

  it('SymposiumConfig composes seats, turnRules, and interceptMode', () => {
    const config: SymposiumConfig = {
      seats: [
        { name: 'Architect', model: 'claude-opus-4-6', systemPrompt: 'Design.', color: '#3B82F6' },
        { name: 'Critic', model: 'gemini-2.5-pro', systemPrompt: 'Challenge.', color: '#EF4444' },
      ],
      turnRules: { mode: 'round-robin', maxTurns: 10 },
      interceptMode: 'manual',
    };
    expect(config.seats).toHaveLength(2);
    expect(config.turnRules.mode).toBe('round-robin');
    expect(config.interceptMode).toBe('manual');
  });

  it('SessionMeta includes sessionType and symposiumConfig', () => {
    const meta: SessionMeta = {
      sessionId: 's1',
      summary: 'symposium test',
      branch: null,
      cwd: null,
      mode: 'agent',
      isActive: true,
      isHidden: false,
      promptCount: 0,
      manuallyRenamed: false,
      initialPrompt: null,
      wtId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
      goalId: null,
      telosTaskId: null,
      closedBy: null,
      lastSpeaker: null,
      lastSpeakerAt: null,
      state: null,
      lastStateChange: null,
      agentName: null,
      bootContext: null,
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify({
        seats: [
          { name: 'A', model: 'claude-opus-4-6', systemPrompt: '', color: '#000' },
          { name: 'B', model: 'gemini-2.5-pro', systemPrompt: '', color: '#FFF' },
        ],
        turnRules: { mode: 'round-robin', maxTurns: 10 },
        interceptMode: 'auto',
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(meta.sessionType).toBe('symposium');
    expect(meta.symposiumConfig).not.toBeNull();
  });
});
