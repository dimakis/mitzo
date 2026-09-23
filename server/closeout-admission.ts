import { createHash } from 'node:crypto';
import type { AccountBinding } from '@mitzo/protocol';
import type { CloseoutEpisode } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { admitProviderDispatch, type ProviderDispatchAdmission } from './provider-execution.js';

export interface CloseoutAdmissionRequest {
  sessionId: string;
  episode: CloseoutEpisode;
  prompt: string;
  promptRevision: string;
  task: string;
  model?: string;
  reasoningEffort?: string | null;
  accountBinding?: Pick<AccountBinding, 'accountId' | 'provider' | 'profileRevision'>;
}

export interface CloseoutAdmission extends ProviderDispatchAdmission {
  messageId: string;
}

export function closeoutMessageId(sessionId: string, episodeId: string): string {
  const digest = createHash('sha256')
    .update(`mitzo-closeout\0${sessionId}\0${episodeId}`)
    .digest('hex');
  return `closeout-${digest}`;
}

export function admitCloseout(options: {
  store: EventStore;
  request: CloseoutAdmissionRequest;
  prepare: (messageId: string) => void;
}): CloseoutAdmission {
  const messageId = closeoutMessageId(options.request.sessionId, options.request.episode.id);
  const admission = admitProviderDispatch({
    store: options.store,
    request: {
      sessionId: options.request.sessionId,
      clientMsgId: messageId,
      effectivePrompt: options.request.prompt,
      fingerprintSource: JSON.stringify({
        kind: 'closeout',
        version: 1,
        episodeId: options.request.episode.id,
        source: options.request.episode.source,
        promptRevision: options.request.promptRevision,
        task: options.request.task,
      }),
      model: options.request.model,
      reasoningEffort: options.request.reasoningEffort,
      accountBinding: options.request.accountBinding,
    },
    prepare: () => options.prepare(messageId),
  });
  return { ...admission, messageId };
}
