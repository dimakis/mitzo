import { useEffect, useState } from 'react';
import { CollaborationApiError } from '@mitzo/client';
import type {
  ConversationArtifactOption,
  ConversationJoiningOwner,
} from '../lib/conversation-joining-review';

/** Lazy metadata read under the existing source owner; never begins sharing. */
export function useConversationContextArtifacts(
  owner: ConversationJoiningOwner | undefined,
  open: boolean,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    owner: ConversationJoiningOwner;
    artifacts?: ConversationArtifactOption[];
    loading: boolean;
    error?: string;
  }>();
  useEffect(() => {
    if (!open || !owner?.loadArtifacts || owner.artifacts) return;
    const controller = new AbortController();
    setState({ owner, loading: true });
    void owner.loadArtifacts(controller.signal).then(
      (artifacts) => {
        if (!controller.signal.aborted) setState({ owner, artifacts, loading: false });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('Starting context artifact catalog unavailable', {
          code: 'conversation_context_artifacts_unavailable',
          stage: 'source_artifacts',
          sourceConversationId: owner.sourceConversationId,
          status: cause instanceof CollaborationApiError ? cause.status : undefined,
          sourceCode: cause instanceof CollaborationApiError ? cause.code : undefined,
        });
        setState({
          owner,
          loading: false,
          error: 'Retained artifacts could not be read. Your selections are unchanged.',
        });
      },
    );
    return () => controller.abort();
  }, [owner, open, attempt]);
  const current = state?.owner === owner ? state : undefined;
  return {
    artifacts: owner?.artifacts ?? current?.artifacts,
    loading: current?.loading ?? false,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
