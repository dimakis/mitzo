import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { changeConversationReadState } from '../lib/conversation-read-state';

/** The visible completed reply is the acknowledgement, never a list-row view. */
export function useReplyReadReceipt(
  sessionId: string | undefined,
  replySeq: number,
  scroller: RefObject<HTMLElement | null>,
) {
  const visit = useRef({ sessionId, acknowledged: 0 });
  const [failure, setFailure] = useState<{ sessionId: string; seq: number; message: string }>();
  const acknowledge = useCallback(async () => {
    if (!sessionId || !replySeq || document.visibilityState !== 'visible') return;
    if (visit.current.sessionId !== sessionId) visit.current = { sessionId, acknowledged: 0 };
    if (visit.current.acknowledged >= replySeq) return;
    visit.current.acknowledged = replySeq;
    try {
      await changeConversationReadState(sessionId, { readReplySeq: replySeq });
      setFailure((current) =>
        current?.sessionId === sessionId && current.seq <= replySeq ? undefined : current,
      );
    } catch (cause) {
      setFailure((current) =>
        current?.sessionId === sessionId && current.seq > replySeq
          ? current
          : {
              sessionId,
              seq: replySeq,
              message:
                cause instanceof Error ? cause.message : 'Couldn’t save read status. Try again.',
            },
      );
    }
  }, [sessionId, replySeq]);

  useEffect(() => {
    if (!sessionId || !replySeq || typeof IntersectionObserver === 'undefined') return;
    const root = scroller.current;
    const targets = root?.querySelectorAll<HTMLElement>(`[data-read-reply-seq="${replySeq}"]`);
    if (!root || !targets?.length) return;
    let visible = false;
    const intersections = new Map<Element, boolean>();
    const check = () => {
      if (visible) void acknowledge();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => intersections.set(entry.target, entry.isIntersecting));
        visible = [...intersections.values()].some(Boolean);
        check();
      },
      { root, threshold: 0.01 },
    );
    targets.forEach((target) => observer.observe(target));
    document.addEventListener('visibilitychange', check);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', check);
    };
  }, [sessionId, replySeq, scroller, acknowledge]);

  const retry = () => {
    visit.current.acknowledged = 0;
    void acknowledge();
  };
  return {
    error:
      failure && failure.sessionId === sessionId && failure.seq === replySeq
        ? failure.message
        : undefined,
    retry,
  };
}
