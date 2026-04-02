import { describe, it, expect } from 'vitest';
import { groupMessages } from '../groupMessages';
import { TOOL_GROUP_THRESHOLD } from '../constants';
import type { Message } from '../../types/chat';

function tool(id: string, done = false): Message {
  return {
    role: 'tool',
    toolName: 'Read',
    toolId: id,
    toolInput: id,
    ...(done ? { toolResult: 'ok' } : {}),
  };
}

function thinking(streaming = false): Message {
  return { role: 'thinking', text: 'some thought', streaming };
}

function user(): Message {
  return { role: 'user', text: 'hi' };
}

function assistant(): Message {
  return { role: 'assistant', text: 'hello' };
}

describe('groupMessages', () => {
  describe('non-streaming (default)', () => {
    it('keeps individual tools below threshold as message items', () => {
      const msgs = [user(), tool('t1'), tool('t2')];
      const grouped = groupMessages(msgs);
      expect(grouped).toHaveLength(3);
      expect(grouped[0].type).toBe('message');
      expect(grouped[1].type).toBe('message');
      expect(grouped[2].type).toBe('message');
    });

    it('groups tools at or above threshold into a tool-group', () => {
      const tools = Array.from({ length: TOOL_GROUP_THRESHOLD }, (_, i) => tool(`t${i}`));
      const msgs = [user(), ...tools];
      const grouped = groupMessages(msgs);
      expect(grouped).toHaveLength(2);
      expect(grouped[1].type).toBe('tool-group');
      if (grouped[1].type === 'tool-group') {
        expect(grouped[1].tools).toHaveLength(TOOL_GROUP_THRESHOLD);
      }
    });

    it('flushes separate tool batches independently', () => {
      const msgs = [
        user(),
        tool('t1'),
        tool('t2'),
        thinking(),
        tool('t3'),
        tool('t4'),
        tool('t5'),
        assistant(),
      ];
      const grouped = groupMessages(msgs);
      // first batch: 2 tools → individual; second batch: 3 tools → group
      const types = grouped.map((g) => g.type);
      expect(types).toEqual([
        'message', // user
        'message', // t1
        'message', // t2
        'message', // thinking
        'tool-group', // t3+t4+t5
        'message', // assistant
      ]);
    });
  });

  describe('streaming = true', () => {
    it('never groups tools even when count meets threshold', () => {
      const tools = Array.from({ length: TOOL_GROUP_THRESHOLD }, (_, i) => tool(`t${i}`));
      const msgs = [user(), ...tools];
      const grouped = groupMessages(msgs, true);
      // all tools remain individual
      expect(grouped).toHaveLength(1 + TOOL_GROUP_THRESHOLD);
      expect(grouped.every((g) => g.type === 'message')).toBe(true);
    });

    it('never groups tools even far above threshold', () => {
      const tools = Array.from({ length: 10 }, (_, i) => tool(`t${i}`));
      const msgs = [user(), ...tools];
      const grouped = groupMessages(msgs, true);
      expect(grouped).toHaveLength(11);
      expect(grouped.every((g) => g.type === 'message')).toBe(true);
    });

    it('preserves thinking blocks as individual messages while streaming', () => {
      const msgs = [user(), thinking(true), tool('t1'), tool('t2'), tool('t3')];
      const grouped = groupMessages(msgs, true);
      expect(grouped).toHaveLength(5);
      expect(grouped[1].type).toBe('message');
      if (grouped[1].type === 'message') {
        expect(grouped[1].message.role).toBe('thinking');
      }
    });
  });

  describe('streaming → non-streaming transition', () => {
    it('groups same messages once streaming stops', () => {
      const msgs = [user(), tool('t1'), tool('t2'), tool('t3')];
      const duringStream = groupMessages(msgs, true);
      const afterDone = groupMessages(msgs, false);
      expect(duringStream).toHaveLength(4); // individual
      expect(afterDone).toHaveLength(2); // user + group
      expect(afterDone[1].type).toBe('tool-group');
    });
  });
});
