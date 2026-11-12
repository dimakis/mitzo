export interface ChatComposerCapabilities {
  terminalHref?: string;
  commands: 'ordinary' | 'legacy' | 'unavailable';
}

/** Navigation hints only. The destination and command owners still authorize effects. */
export function chatComposerCapabilities(input: {
  ordinary: boolean;
  location?: 'local' | 'openshell';
  sessionId?: string | null;
  draftId?: string;
  blocked: boolean;
}): ChatComposerCapabilities {
  if (input.blocked) return { commands: 'unavailable' };
  const commands = input.ordinary
    ? input.location === 'local'
      ? 'ordinary'
      : 'unavailable'
    : 'legacy';
  const params = new URLSearchParams();
  if (input.sessionId) params.set('sessionId', input.sessionId);
  else if (!input.ordinary || input.location !== 'local') return { commands };
  params.set(
    'returnTo',
    input.sessionId
      ? `/chat/${input.sessionId}`
      : input.draftId
        ? `/chat?draft=${encodeURIComponent(input.draftId)}`
        : '/chat',
  );
  return { terminalHref: `/terminal?${params}`, commands };
}
