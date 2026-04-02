import type { Message, GroupedItem } from '../types/chat';
import { TOOL_GROUP_THRESHOLD } from './constants';

export function groupMessages(messages: Message[], streaming = false): GroupedItem[] {
  const result: GroupedItem[] = [];
  let toolBuffer: Message[] = [];

  function flushTools() {
    if (toolBuffer.length === 0) return;
    if (!streaming && toolBuffer.length >= TOOL_GROUP_THRESHOLD) {
      result.push({
        type: 'tool-group',
        tools: toolBuffer,
        key: toolBuffer[0].toolId ?? `tg-${result.length}`,
      });
    } else {
      for (const t of toolBuffer) {
        result.push({ type: 'message', message: t });
      }
    }
    toolBuffer = [];
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      toolBuffer.push(msg);
    } else {
      flushTools();
      result.push({ type: 'message', message: msg });
    }
  }
  flushTools();
  return result;
}
