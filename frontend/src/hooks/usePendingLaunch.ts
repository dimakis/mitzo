import { useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';
import { useRef, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import type { BriefingChatBinding } from '@mitzo/protocol';

/** Shared launch state survives navigation until delivery is acknowledged or dismissed. */
export function usePendingLaunch() {
  const launch = useMitzoStore((s) => s.pendingSession);
  const launchSending = useMitzoStore((s) => s.pendingSessionSending);
  const dismissLaunch = useMitzoStore((s) => s.clearPendingSession);
  const storeSendLaunch = useMitzoStore((s) => s.sendPendingSession);
  const [registrationError, setRegistrationError] = useState('');
  const registration = useRef<Omit<BriefingChatBinding, 'createdAt'> | null>(null);
  async function registerBriefing(binding: Omit<BriefingChatBinding, 'createdAt'>) {
    registration.current = binding;
    setRegistrationError('');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await apiFetch('/api/home/briefing-chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(binding),
        });
        if (response.ok) {
          if (registration.current === binding) registration.current = null;
          window.dispatchEvent(new CustomEvent('mitzo-briefing-chat', { detail: binding }));
          return;
        }
        if (![404, 409].includes(response.status)) break;
      } catch {
        break;
      }
      // Assignment can precede provider metadata persistence. Never retry a model turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
    if (registration.current === binding)
      setRegistrationError(
        'Conversation started, but its briefing link could not be saved. Retry saving the link.',
      );
  }
  function sendLaunch(opts?: SendMessageOptions): boolean {
    const reviewed = launch;
    return storeSendLaunch({
      ...opts,
      onSessionAssigned(sessionId) {
        opts?.onSessionAssigned?.(sessionId);
        if (reviewed?.briefing && reviewed.accountSelection)
          void registerBriefing({
            ...reviewed.briefing,
            sessionId,
            accountId: reviewed.accountSelection.accountId,
            model: reviewed.accountSelection.model,
          });
      },
    });
  }
  const storeSend = useMitzoStore((s) => s.sendMessage);
  function sendMessage(text: string, opts?: SendMessageOptions): boolean {
    storeSend(text, opts);
    return true;
  }
  function retryRegistration() {
    if (registration.current) void registerBriefing(registration.current);
  }
  return {
    launch,
    launchSending,
    dismissLaunch,
    sendMessage,
    sendLaunch,
    registrationError,
    retryRegistration,
  };
}
