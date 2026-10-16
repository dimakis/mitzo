import { useEffect, useState } from 'react';
import type { FinishedMessage } from '../types/chat';
import { apiFetch } from '../lib/api-fetch';
export interface PreviewMessage {
  id: string;
  role: string;
  text: string;
}
export function useSavedSessionMessages(sessionId: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    id: string;
    messages: PreviewMessage[] | null;
    error: boolean;
  }>({ id: sessionId, messages: null, error: false });
  useEffect(() => {
    const controller = new AbortController();
    setState({ id: sessionId, messages: null, error: false });
    void apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        const history: FinishedMessage[] = await response.json();
        if (!Array.isArray(history)) throw new Error('Invalid preview');
        const messages = history
          .filter(
            (message) =>
              ['user', 'assistant'].includes(message?.role) && Array.isArray(message.blocks),
          )
          .map((message) => ({
            id: message.messageId,
            role: message.role,
            text: message.blocks
              .filter((block) => block?.blockType === 'text' && typeof block.content === 'string')
              .map((block) => block.content)
              .join('\n\n'),
          }))
          .filter((message) => message.text.trim())
          .slice(-3)
          .map((message) => ({ ...message, text: message.text.slice(0, 12000) }));
        if (!controller.signal.aborted) setState({ id: sessionId, messages, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ id: sessionId, messages: null, error: true });
      });
    return () => controller.abort();
  }, [sessionId, attempt]);
  return {
    messages: state.id === sessionId ? state.messages : null,
    error: state.id === sessionId && state.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
