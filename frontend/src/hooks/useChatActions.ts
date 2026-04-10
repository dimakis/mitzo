import { useCallback } from 'react';
import { wsIsOpen, wsSend, wsSetRunning } from '../lib/ws-pool';
import type { ImageAttachment } from '../types/chat';

function generateClientMsgId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ChatActionsDeps {
  poolKey: string;
  sessionState: {
    model: string;
    mode: string;
    currentSessionId: string | undefined;
    sandbox: boolean;
  };
  searchParams: URLSearchParams;
  dispatch: (action: { type: string; [key: string]: unknown }) => void;
  pendingSend: React.RefObject<unknown | null>;
  forceScrollToBottom: () => void;
  voice: { stopSpeaking: () => void };
  running: boolean;
}

export function useChatActions({
  poolKey,
  sessionState,
  searchParams,
  dispatch,
  pendingSend,
  forceScrollToBottom,
  voice,
  running,
}: ChatActionsDeps) {
  function buildSendPayload(
    text: string,
    clientMsgId: string,
    images?: ImageAttachment[],
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: 'send',
      prompt: text,
      clientMsgId,
      model: sessionState.model,
      mode: sessionState.mode,
    };
    if (sessionState.currentSessionId) payload.resume = sessionState.currentSessionId;
    if (images?.length) {
      payload.images = images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    }
    if (sessionState.sandbox && !sessionState.currentSessionId) payload.worktree = true;
    const cwd = searchParams.get('cwd');
    if (cwd) payload.cwd = cwd;
    const extraTools = searchParams.get('extraTools');
    if (extraTools) payload.extraTools = extraTools;
    return payload;
  }

  function sendMessage(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): boolean {
    if (!wsIsOpen(poolKey)) {
      dispatch({ type: 'CONNECTION_LOST' });
      return false;
    }
    voice.stopSpeaking();
    const clientMsgId = generateClientMsgId();
    const payload = buildSendPayload(text, clientMsgId, images);
    if (ctxBlocks?.length) payload.contextBlocks = ctxBlocks;
    const previews = images?.map((img) => img.preview);
    if (!running) wsSetRunning(poolKey, true);
    wsSend(poolKey, payload);
    dispatch({ type: 'USER_SEND', text, clientMsgId, images: previews, contextBlocks: ctxBlocks });
    forceScrollToBottom();
    return true;
  }

  function interruptMessage(text: string, images?: ImageAttachment[], ctxBlocks?: string[]): void {
    if (!wsIsOpen(poolKey) || !running) return;
    const clientMsgId = generateClientMsgId();
    const imagePayload = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
    const previews = images?.map((img) => img.preview);
    wsSend(poolKey, {
      type: 'interrupt',
      prompt: text,
      clientMsgId,
      images: imagePayload,
      ...(ctxBlocks?.length ? { contextBlocks: ctxBlocks } : {}),
    });
    dispatch({ type: 'USER_SEND', text, clientMsgId, images: previews, contextBlocks: ctxBlocks });
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    pendingSend.current = null;
    wsSend(poolKey, { type: 'stop' });
    wsSetRunning(poolKey, false);
    dispatch({ type: 'SET_RUNNING', running: false });
  }, [poolKey, dispatch, pendingSend]);

  return { sendMessage, interruptMessage, handleStop };
}
