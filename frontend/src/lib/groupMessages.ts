import type { Message, GroupedItem } from '../types/chat';

export function groupMessages(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let toolBuffer: Message[] = [];

  function flushTools() {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length >= 3) {
      result.push({ type: 'tool-group', tools: toolBuffer });
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
