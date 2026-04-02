import { useReducer, useRef, useEffect, useCallback } from 'react';
import { CHAT_CACHE_KEY_PREFIX } from '../lib/constants';
import type { Message, PermissionRequest, ToolTier, RawToolInput } from '../types/chat';
import type { WsMsg } from '../lib/ws-pool';
import { wsSetRunning, wsSend } from '../lib/ws-pool';

export interface ChatMessagesState {
  messages: Message[];
  running: boolean;
  permission: PermissionRequest | null;
  branch: string | null;
  isWorktree: boolean;
}

export type ChatMessagesAction =
  | { type: 'THINKING_START' }
  | { type: 'THINKING_DELTA'; text: string }
  | { type: 'TEXT_DELTA'; text: string }
  | { type: 'TEXT'; text: string }
  | { type: 'TOOL_CALL'; toolName: string; toolId: string; input: string; rawInput?: RawToolInput }
  | { type: 'TOOL_RESULT'; toolId: string; result: string }
  | { type: 'PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'PERMISSION_TIMEOUT'; permId: string }
  | { type: 'DONE'; sessionId?: string }
  | { type: 'ERROR'; error: string }
  | { type: 'SESSION_INFO'; branch: string; isWorktree: boolean }
  | { type: 'RESTORE'; messages: Message[] }
  | { type: 'USER_SEND'; text: string; images?: string[] }
  | { type: 'SET_RUNNING'; running: boolean }
  | { type: 'CONNECTION_LOST' };

const INITIAL_STATE: ChatMessagesState = {
  messages: [],
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
};

function finalizeThinking(messages: Message[], thinkingText: string): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'thinking' && last.streaming) {
    return [...messages.slice(0, -1), { role: 'thinking' as const, text: thinkingText }];
  }
  return messages;
}

export function chatMessagesReducer(
  state: ChatMessagesState,
  action: ChatMessagesAction,
): ChatMessagesState {
  switch (action.type) {
    case 'THINKING_START':
      return {
        ...state,
        messages: [...state.messages, { role: 'thinking', text: '', streaming: true }],
      };

    case 'THINKING_DELTA': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'thinking' && last.streaming) {
        return {
          ...state,
          messages: [
            ...state.messages.slice(0, -1),
            { role: 'thinking', text: (last.text || '') + action.text, streaming: true },
          ],
        };
      }
      return state;
    }

    case 'TEXT_DELTA': {
      let msgs = state.messages;
      const last = msgs[msgs.length - 1];
      if (last?.role === 'thinking' && last.streaming) {
        msgs = finalizeThinking(msgs, last.text || '');
      }
      const prevLast = msgs[msgs.length - 1];
      if (prevLast?.role === 'assistant' && prevLast.streaming) {
        return {
          ...state,
          messages: [
            ...msgs.slice(0, -1),
            { role: 'assistant', text: (prevLast.text || '') + action.text, streaming: true },
          ],
        };
      }
      return {
        ...state,
        messages: [...msgs, { role: 'assistant', text: action.text, streaming: true }],
      };
    }

    case 'TEXT': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return {
          ...state,
          messages: [...state.messages.slice(0, -1), { role: 'assistant', text: action.text }],
        };
      }
      return {
        ...state,
        messages: [...state.messages, { role: 'assistant', text: action.text }],
      };
    }

    case 'TOOL_CALL': {
      let msgs = state.messages;
      const last = msgs[msgs.length - 1];
      if (last?.role === 'thinking' && last.streaming) {
        msgs = finalizeThinking(msgs, last.text || '');
      }
      return {
        ...state,
        messages: [
          ...msgs,
          {
            role: 'tool',
            toolName: action.toolName,
            toolId: action.toolId,
            toolInput: action.input,
            rawInput: action.rawInput,
          },
        ],
      };
    }

    case 'TOOL_RESULT':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.toolId === action.toolId ? { ...m, toolResult: action.result } : m,
        ),
      };

    case 'PERMISSION_REQUEST':
      return { ...state, permission: action.payload };

    case 'PERMISSION_TIMEOUT':
      return {
        ...state,
        permission: state.permission?.permId === action.permId ? null : state.permission,
      };

    case 'DONE': {
      let msgs = state.messages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.role === 'thinking' && lastMsg.streaming) {
        msgs = finalizeThinking(msgs, lastMsg.text || '');
      }
      const prevLast = msgs[msgs.length - 1];
      if (prevLast?.role === 'assistant' && prevLast.streaming) {
        msgs = [...msgs.slice(0, -1), { role: 'assistant' as const, text: prevLast.text || '' }];
      }
      return { ...state, messages: msgs, running: false };
    }

    case 'ERROR':
      return {
        ...state,
        messages: [...state.messages, { role: 'assistant', text: `**Error:** ${action.error}` }],
        running: false,
      };

    case 'SESSION_INFO':
      return { ...state, branch: action.branch, isWorktree: action.isWorktree };

    case 'RESTORE':
      return { ...state, messages: action.messages };

    case 'USER_SEND':
      return {
        ...state,
        messages: [...state.messages, { role: 'user', text: action.text, images: action.images }],
        running: true,
      };

    case 'SET_RUNNING':
      return { ...state, running: action.running };

    case 'CONNECTION_LOST':
      return {
        ...state,
        messages: [
          ...state.messages,
          { role: 'assistant', text: '**Connection lost.** Reconnecting — try again in a moment.' },
        ],
      };

    default:
      return state;
  }
}

export function useChatMessages(
  poolKey: string,
  currentSessionId: string | undefined,
  onSessionAssigned: (id: string) => void,
  onSessionExpired: (sessionId: string | undefined) => void,
) {
  const [state, dispatch] = useReducer(chatMessagesReducer, INITIAL_STATE);
  const pendingSend = useRef<Record<string, unknown> | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  useEffect(() => {
    const id = currentSessionIdRef.current;
    if (!id || state.messages.length === 0) return;
    try {
      localStorage.setItem(`${CHAT_CACHE_KEY_PREFIX}${id}`, JSON.stringify(state.messages));
    } catch {
      // localStorage quota exceeded — non-fatal
    }
  }, [state.messages, currentSessionId]);

  const handleWsMessage = useCallback(
    (msg: WsMsg) => {
      switch (msg.type) {
        case '_open':
        case '_close':
          break;

        case 'reattached':
          dispatch({ type: 'SET_RUNNING', running: true });
          wsSetRunning(poolKey, true);
          if (msg.sessionId) onSessionAssigned(msg.sessionId as string);
          break;

        case 'reattach_failed':
          dispatch({ type: 'SET_RUNNING', running: false });
          wsSetRunning(poolKey, false);
          if (currentSessionIdRef.current) {
            fetch(`/api/sessions/${currentSessionIdRef.current}/messages`, {
              credentials: 'include',
            })
              .then((r) => r.json())
              .then((data: { messages?: Message[] }) => {
                if (data.messages?.length) dispatch({ type: 'RESTORE', messages: data.messages });
              })
              .catch(() => {
                // Network error — non-fatal
              });
          }
          break;

        case 'session_info':
          dispatch({
            type: 'SESSION_INFO',
            branch: msg.branch as string,
            isWorktree: msg.worktree as boolean,
          });
          break;

        case 'session_id':
          onSessionAssigned(msg.sessionId as string);
          break;

        case 'thinking_start':
          dispatch({ type: 'THINKING_START' });
          break;

        case 'thinking_delta':
          dispatch({ type: 'THINKING_DELTA', text: msg.text as string });
          break;

        case 'text_delta':
          dispatch({ type: 'TEXT_DELTA', text: msg.text as string });
          break;

        case 'text':
          dispatch({ type: 'TEXT', text: msg.text as string });
          break;

        case 'tool_call':
          dispatch({
            type: 'TOOL_CALL',
            toolName: msg.toolName as string,
            toolId: msg.toolId as string,
            input: msg.input as string,
            rawInput: msg.rawInput as RawToolInput | undefined,
          });
          break;

        case 'tool_result':
          dispatch({
            type: 'TOOL_RESULT',
            toolId: msg.toolId as string,
            result: msg.result as string,
          });
          break;

        case 'permission_request':
          dispatch({
            type: 'PERMISSION_REQUEST',
            payload: {
              permId: msg.permId as string,
              toolName: msg.toolName as string,
              toolInput: msg.toolInput as string,
              title: msg.title as string | undefined,
              description: msg.description as string | undefined,
              displayName: msg.displayName as string | undefined,
              tier: msg.tier as ToolTier | undefined,
            },
          });
          break;

        case 'permission_timeout':
          dispatch({ type: 'PERMISSION_TIMEOUT', permId: msg.permId as string });
          break;

        case 'done': {
          dispatch({ type: 'DONE', sessionId: msg.sessionId as string | undefined });
          wsSetRunning(poolKey, false);
          if (msg.sessionId && !currentSessionIdRef.current) {
            onSessionAssigned(msg.sessionId as string);
          }
          const pending = pendingSend.current;
          if (pending) {
            pendingSend.current = null;
            dispatch({ type: 'SET_RUNNING', running: true });
            wsSetRunning(poolKey, true);
            wsSend(poolKey, pending);
          }
          break;
        }

        case 'error': {
          const errorMsg = msg.error as string;
          wsSetRunning(poolKey, false);
          pendingSend.current = null;
          if (errorMsg?.includes('No conversation found')) {
            onSessionExpired(currentSessionIdRef.current);
            dispatch({
              type: 'ERROR',
              error: 'Session expired. Send your message again to start fresh.',
            });
          } else {
            dispatch({ type: 'ERROR', error: errorMsg || 'Unknown error' });
          }
          break;
        }
      }
    },
    [poolKey, onSessionAssigned, onSessionExpired],
  );

  return { state, dispatch, pendingSend, handleWsMessage };
}
