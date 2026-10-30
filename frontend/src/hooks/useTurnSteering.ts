import { useRef, useState } from 'react';
import { z } from 'zod';
import type { SendMessageOptions } from '@mitzo/client';
import { MessageReplyIdSchema, ChatMessageTextSchema } from '@mitzo/protocol';
import { chatStorage } from '../lib/large-chat-storage';
import { apiFetch } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
const Request = z.strictObject({
  requestId: z.string().min(1).max(200),
  targetCommandId: z.string().min(1).max(200),
  text: ChatMessageTextSchema,
  replyToMessageId: MessageReplyIdSchema.optional(),
});
type Correction = z.infer<typeof Request>;
type Delivery = SendMessageOptions['onDelivery'];
const key = (id: string) => `mitzo-turn-steering:${id}`;
function retained(id: string | null): Correction | null {
  if (!id) return null;
  const raw = chatStorage.getItem(key(id));
  if (!raw) return null;
  return Request.parse(JSON.parse(raw));
}
export function useTurnSteering(
  sessionId: string | null,
  targetCommandId: string | undefined,
  enabled: boolean,
) {
  const owner = useRef<{
    sessionId: string | null;
    pending: Correction | null;
    blocked: boolean;
    delivery?: Delivery;
    busy: boolean;
  }>({ sessionId: null, pending: null, blocked: false, busy: false });
  if (owner.current.sessionId !== sessionId) {
    let pending: Correction | null = null,
      blocked = false;
    try {
      pending = retained(sessionId);
    } catch {
      blocked = true;
    }
    owner.current = { sessionId, pending, blocked, busy: false };
  }
  const [, render] = useState(0);
  const [feedback, setFeedback] = useState<{ owner: object; error: string }>();
  const selected = owner.current;
  const error = selected.busy
    ? ''
    : feedback?.owner === selected
      ? feedback.error
      : selected.blocked
        ? 'Saved correction is unavailable. Keep this draft.'
        : selected.pending
          ? 'Correction delivery not confirmed. Retry checks the original correction.'
          : '';
  const execute = async (scope: typeof selected, input: Correction, delivery?: Delivery) => {
    if (!scope.sessionId || scope.busy) return;
    scope.busy = true;
    render((n) => n + 1);
    try {
      // Commit before any provider-bound request, including IndexedDB payloads.
      chatStorage.setItem(key(scope.sessionId), JSON.stringify(input));
      await chatStorage.flush();
      if (chatStorage.failed) throw Error('storage');
    } catch {
      scope.busy = false;
      setFeedback({ owner: scope, error: 'Could not save the correction. Your draft was kept.' });
      delivery?.('failed');
      return;
    }
    let status = 'uncertain';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error('timeout'));
        }, 15000);
      });
      const receipt = await Promise.race([
        (async () => {
          const response = await apiFetch(
            `/api/sessions/${encodeURIComponent(scope.sessionId!)}/codex-queue/steer`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
              signal: controller.signal,
            },
          );
          return { ok: response.ok, status: response.status, body: await response.json() };
        })(),
        expired,
      ]);
      if (
        receipt.body.requestId === input.requestId &&
        ['accepted', 'rejected', 'stale_target', 'uncertain'].includes(receipt.body.status)
      )
        status = receipt.body.status;
      // Definite pre-dispatch input/auth refusals preserve the draft without replay.
      else if ([400, 401, 403, 404].includes(receipt.status)) status = 'rejected';
    } catch {
      /* A lost response never authorizes a replacement correction. */
    } finally {
      clearTimeout(timer);
      scope.busy = false;
    }
    if (status === 'accepted' || status === 'rejected' || status === 'stale_target') {
      try {
        const saved = retained(scope.sessionId);
        if (saved?.requestId === input.requestId) {
          chatStorage.removeItem(key(scope.sessionId));
          await chatStorage.flush();
        }
      } catch {
        /* Native identity remains idempotent if a stale receipt survives reload. */
      }
      scope.pending = null;
      scope.delivery = undefined;
      delivery?.(status === 'accepted' ? 'accepted' : 'failed');
      if (owner.current === scope)
        setFeedback({
          owner: scope,
          error:
            status === 'accepted'
              ? ''
              : status === 'stale_target'
                ? 'That turn has finished. Your correction is still in the input; send it as a new message.'
                : 'The correction was not accepted. Your draft was kept.',
        });
    } else {
      scope.pending = input;
      scope.delivery = delivery;
      delivery?.('uncertain');
      if (owner.current === scope)
        setFeedback({
          owner: scope,
          error: 'Correction delivery not confirmed. Retry checks the original correction.',
        });
    }
    render((n) => n + 1);
  };
  return {
    error,
    busy: selected.busy,
    retry: selected.pending
      ? () => void execute(selected, selected.pending!, selected.delivery)
      : undefined,
    submit: (text: string, delivery?: Delivery, replyToMessageId?: string) => {
      if (!enabled || !sessionId || !targetCommandId || selected.busy || selected.blocked) {
        delivery?.('failed');
        return;
      }
      if (selected.pending) {
        if (
          selected.pending.text !== text ||
          selected.pending.replyToMessageId !== replyToMessageId
        ) {
          delivery?.('failed');
          setFeedback({
            owner: selected,
            error: 'Check the previous correction before steering again. Your new text was kept.',
          });
          return;
        }
        void execute(selected, selected.pending, delivery);
        return;
      }
      const input = {
        requestId: createBrowserId(),
        targetCommandId,
        text,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      };
      selected.pending = input;
      selected.delivery = delivery;
      void execute(selected, input, delivery);
    },
  };
}
