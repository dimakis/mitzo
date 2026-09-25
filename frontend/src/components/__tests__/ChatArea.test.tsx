// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
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
  ToolPill: ({ block, sessionId }: { block: { blockId: string }; sessionId?: string }) => (
    <div data-testid="tool-pill" data-session-id={sessionId}>
      {block.blockId}
    </div>
  ),
}));

vi.mock('../ToolGroup', () => ({
  ToolGroup: ({ tools, sessionId }: { tools: Array<{ blockId: string }>; sessionId?: string }) => (
    <div data-testid="tool-group" data-session-id={sessionId}>
      {tools.map((tool) => tool.blockId).join(',')}
    </div>
  ),
}));

vi.mock('../ProgressWidget', () => ({
  ProgressWidget: () => <div data-testid="progress-widget" />,
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

  it('renders concurrent seats in durable start order with immutable account and model labels', () => {
    const reviewer = {
      version: 2 as const,
      seatId: 'reviewer',
      seatLabel: 'Original Reviewer',
      seatRole: 'reviewer',
      configRevision: 1,
      membershipGeneration: 1,
      capturedAt: 1,
      accountBinding: {
        accountId: 'work-reviewer',
        accountLabel: 'Work Reviewer',
        provider: 'openai-codex' as const,
        model: 'model-r',
        profileRevision: 'a1',
      },
      reasoningEffort: 'high',
      profileBinding: { profileId: 'profile-r', profileRevision: 'p1' },
      contextGrant: { grantId: 'context-r', revision: 1 },
      authorityGrant: { grantId: 'authority-r', revision: 1 },
      accountProfileRevision: 'a1',
      seatProfileRevision: 'p1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'shared',
      isolationDomainRevision: 1,
    };
    const architect = {
      ...reviewer,
      seatId: 'architect',
      seatLabel: 'Original Architect',
      seatRole: 'architect',
      accountBinding: {
        ...reviewer.accountBinding,
        accountId: 'work-architect',
        accountLabel: 'Work Architect',
        model: 'model-a',
      },
    };
    const messages: FinishedMessage[] = [
      {
        messageId: 'reviewer-done',
        startedSeq: 3,
        role: 'assistant',
        symposiumProvenance: reviewer,
        blocks: [{ blockId: 'b0', blockType: 'text', content: 'Finished review' }],
      },
    ];
    const currentByMessage = {
      'architect-live': {
        messageId: 'architect-live',
        startedSeq: 2,
        symposiumProvenance: architect,
        blocks: new Map<string, StreamingBlock>([
          ['b0', { blockId: 'b0', blockType: 'text', content: 'Live design', done: false }],
        ]),
        blockOrder: ['b0'],
      },
    };
    const { container } = render(
      <ChatArea {...defaultProps} messages={messages} currentByMessage={currentByMessage} />,
    );
    const turns = [...container.querySelectorAll('.msg-turn')];
    expect(turns).toHaveLength(2);
    expect(turns[0].textContent).toContain('Original Architect');
    expect(turns[0].textContent).toContain('Work Architect');
    expect(turns[0].textContent).toContain('model-a');
    expect(turns[0].textContent).toContain('high');
    expect(turns[1].textContent).toContain('Original Reviewer');
    expect(turns[1].textContent).toContain('Finished review');
  });

  it('keeps legacy seat history honest about unknown account and model', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'legacy',
        role: 'assistant',
        symposiumProvenance: {
          seatId: 'reviewer',
          configRevision: 1,
          accountProfileRevision: 'a1',
          seatProfileRevision: 'p1',
          contextGrantRevision: 1,
          authorityGrantRevision: 1,
          isolationDomainId: 'shared',
          isolationDomainRevision: 1,
        },
        blocks: [{ blockId: 'b0', blockType: 'text', content: 'Historical review' }],
      },
    ];
    render(<ChatArea {...defaultProps} messages={messages} />);
    expect(screen.getByText(/Reviewer seat.*account and model unknown/i)).toBeTruthy();
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

  it('routes finished ordinary tool calls through ToolGroup while progress tools remain direct', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'a1',
        role: 'assistant',
        blocks: [
          {
            blockId: 'ordinary',
            blockType: 'tool_use',
            content: '',
            toolId: 'ordinary',
            toolName: 'Read',
          },
          {
            blockId: 'progress',
            blockType: 'tool_use',
            content: '',
            toolId: 'progress',
            toolName: 'TodoWrite',
          },
        ],
      },
    ];
    render(
      <ChatArea
        {...defaultProps}
        sessionId="origin"
        messages={messages}
        progressByToolId={{ progress: { progressId: 'progress', items: [] } }}
      />,
    );
    expect(screen.getByTestId('tool-group').textContent).toContain('ordinary');
    expect(screen.getByTestId('tool-group').getAttribute('data-session-id')).toBe('origin');
    expect(screen.getByTestId('progress-widget')).toBeTruthy();
  });

  it('routes streaming ordinary tool calls through ToolGroup while progress tools remain direct', () => {
    const current = {
      messageId: 'stream-1',
      blocks: new Map<string, StreamingBlock>([
        [
          'ordinary',
          {
            blockId: 'ordinary',
            blockType: 'tool_use',
            content: '',
            toolId: 'ordinary',
            toolName: 'Read',
            done: false,
          },
        ],
        [
          'progress',
          {
            blockId: 'progress',
            blockType: 'tool_use',
            content: '',
            toolId: 'progress',
            toolName: 'TodoWrite',
            done: false,
          },
        ],
      ]),
      blockOrder: ['ordinary', 'progress'],
    };
    render(
      <ChatArea
        {...defaultProps}
        sessionId="origin"
        current={current}
        progressByToolId={{ progress: { progressId: 'progress', items: [] } }}
      />,
    );
    expect(screen.getByTestId('tool-group').textContent).toContain('ordinary');
    expect(screen.getByTestId('tool-group').getAttribute('data-session-id')).toBe('origin');
    expect(screen.getByTestId('progress-widget')).toBeTruthy();
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

    expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number) });
  });

  it('does not pull a reader back to the bottom as a streaming response grows', () => {
    const scrollRef = { current: null as HTMLDivElement | null };
    const stream = (content: string) => ({
      messageId: 'stream-1',
      blocks: new Map<string, StreamingBlock>([
        ['text-1', { blockId: 'text-1', blockType: 'text', content, done: false }],
      ]),
      blockOrder: ['text-1'],
    });
    const { rerender } = render(
      <ChatArea {...defaultProps} current={stream('First streamed line')} scrollRef={scrollRef} />,
    );
    const el = scrollRef.current!;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    el.scrollTop = 600;
    fireEvent.scroll(el);

    rerender(
      <ChatArea
        {...defaultProps}
        current={stream('First streamed line\nA later streamed line')}
        scrollRef={scrollRef}
      />,
    );

    expect(el.scrollTop).toBe(600);
  });

  it('respects a reader who scrolled up while another seat streams', () => {
    const scrollRef = { current: null as HTMLDivElement | null };
    const stream = (content: string) => ({
      messageId: 'seat-stream',
      blocks: new Map<string, StreamingBlock>([
        ['b0', { blockId: 'b0', blockType: 'text', content, done: false }],
      ]),
      blockOrder: ['b0'],
    });
    const { rerender } = render(
      <ChatArea
        {...defaultProps}
        currentByMessage={{ seat: stream('First line') }}
        scrollRef={scrollRef}
      />,
    );
    const el = scrollRef.current!;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    el.scrollTop = 600;
    fireEvent.scroll(el);
    rerender(
      <ChatArea
        {...defaultProps}
        currentByMessage={{ seat: stream('First line\nMore') }}
        scrollRef={scrollRef}
      />,
    );
    expect(el.scrollTop).toBe(600);
  });
});
