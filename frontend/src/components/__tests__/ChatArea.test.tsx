// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { ChatArea } from '../ChatArea';
import type { FinishedMessage, StreamingBlock } from '../../types/chat';

// Mock child components to isolate ChatArea tests
vi.mock('../MessageBubble', () => ({
  UserBubble: ({ text }: { text?: string }) => <div data-testid="user-bubble">{text}</div>,
  TextBubble: ({ content }: { content: string }) => <div data-testid="text-bubble">{content}</div>,
}));

vi.mock('../ThinkingBlock', () => ({
  ThinkingBlock: ({ block }: { block: { blockId: string } }) => (
    <div data-testid="thinking-block">{block.blockId}</div>
  ),
}));

vi.mock('../ToolPill', () => ({
  ToolPill: ({ block }: { block: { blockId: string } }) => (
    <div data-testid="tool-pill">{block.blockId}</div>
  ),
}));

vi.mock('../ToolGroup', () => ({
  ToolGroup: () => <div data-testid="tool-group" />,
}));

vi.mock('../PermissionBanner', () => ({
  PermissionBanner: ({ permId }: { permId: string }) => (
    <div data-testid="permission-banner">{permId}</div>
  ),
}));

afterEach(() => cleanup());

describe('ChatArea', () => {
  const defaultProps = {
    messages: [] as FinishedMessage[],
    current: null,
    running: false,
    permission: null,
    onPermissionRespond: vi.fn(),
  };

  it('renders empty state when no messages', () => {
    render(<ChatArea {...defaultProps} />);
    expect(screen.getByText('Send a message to start')).toBeTruthy();
  });

  it('does not render empty state when running', () => {
    render(<ChatArea {...defaultProps} running={true} />);
    expect(screen.queryByText('Send a message to start')).toBeNull();
  });

  it('renders user messages', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'u1',
        role: 'user',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'Hello' }],
      },
    ];
    render(<ChatArea {...defaultProps} messages={messages} />);
    expect(screen.getByTestId('user-bubble')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
  });

  it('renders assistant text blocks', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'a1',
        role: 'assistant',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'Hi there' }],
      },
    ];
    render(<ChatArea {...defaultProps} messages={messages} />);
    expect(screen.getByTestId('text-bubble')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('renders streaming turn when current is provided', () => {
    const blocks = new Map<string, StreamingBlock>();
    blocks.set('sb1', {
      blockId: 'sb1',
      blockType: 'text',
      content: 'Streaming...',
      done: false,
    });
    const current = {
      messageId: 'stream-1',
      blocks,
      blockOrder: ['sb1'],
    };
    render(<ChatArea {...defaultProps} current={current} />);
    expect(screen.getByText('Streaming...')).toBeTruthy();
  });

  it('renders PermissionBanner when permission is present', () => {
    const permission = {
      permId: 'perm-1',
      toolName: 'Bash',
      toolInput: 'ls',
      title: 'Allow Bash?',
      description: 'Execute shell command',
      displayName: 'Bash',
      tier: 'elevated' as const,
    };
    render(<ChatArea {...defaultProps} permission={permission} />);
    expect(screen.getByTestId('permission-banner')).toBeTruthy();
    expect(screen.getByText('perm-1')).toBeTruthy();
  });

  it('does not render PermissionBanner when no permission', () => {
    render(<ChatArea {...defaultProps} />);
    expect(screen.queryByTestId('permission-banner')).toBeNull();
  });

  it('renders thinking blocks', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'a1',
        role: 'assistant',
        blocks: [{ blockId: 'tb1', blockType: 'thinking', content: 'thinking...' }],
      },
    ];
    render(<ChatArea {...defaultProps} messages={messages} />);
    expect(screen.getByTestId('thinking-block')).toBeTruthy();
  });

  it('scrolls to bottom when messages appear for the first time (session restore)', async () => {
    const scrollRef = { current: null as HTMLDivElement | null };
    const restoredMessages: FinishedMessage[] = [
      {
        messageId: 'u1',
        role: 'user',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'Hello' }],
      },
      {
        messageId: 'a1',
        role: 'assistant',
        blocks: [{ blockId: 'b2', blockType: 'text', content: 'Hi there' }],
      },
    ];

    // Initial render with no messages
    const { rerender } = render(<ChatArea {...defaultProps} scrollRef={scrollRef} />);

    // Spy on scrollTo after the ref is attached
    const scrollTo = vi.fn();
    if (scrollRef.current) {
      scrollRef.current.scrollTo = scrollTo;
    }

    // Simulate RESTORE: messages appear in one shot
    await act(async () => {
      rerender(<ChatArea {...defaultProps} messages={restoredMessages} scrollRef={scrollRef} />);
    });

    // Give the rAF time to fire
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(scrollTo).toHaveBeenCalled();
  });
});
