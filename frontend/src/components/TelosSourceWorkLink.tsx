import { useTelosSourceNavigation } from '../hooks/useTelosSourceNavigation';
import { SessionWorkLink } from './SessionWorkLink';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  TelosWorkRoleContextSelectionSchema,
  type TelosWorkRoleContextSelection,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { TelosLinkedContext } from './TelosLinkedContext';

/** The compact item row is shared by the mobile and desktop ordinary chat. */
export function TelosSourceWorkLink({ conversationId }: { conversationId?: string } = {}) {
  const source = useTelosSourceNavigation();
  const [role, setRole] = useState<{
    conversationId: string;
    context?: TelosWorkRoleContextSelection;
    error?: boolean;
  }>();
  useEffect(() => {
    if (source || !conversationId) return;
    const controller = new AbortController();
    void apiFetch(`/api/sessions/${encodeURIComponent(conversationId)}/meta`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Role context unavailable');
        const metadata = await response.json();
        if (metadata.sessionId !== conversationId) throw new Error('Role context identity changed');
        const context =
          metadata.telosWorkRoleContext === undefined
            ? undefined
            : TelosWorkRoleContextSelectionSchema.parse(metadata.telosWorkRoleContext);
        if (!controller.signal.aborted) setRole({ conversationId, context });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRole({ conversationId, error: true });
      });
    return () => controller.abort();
  }, [conversationId, source]);
  if (!source) {
    if (!conversationId || role?.conversationId !== conversationId) return null;
    if (role.error)
      return (
        <div className="telos-chat-context" role="status">
          Linked work context unavailable.
        </div>
      );
    const context = role.context;
    if (!context) return null;
    return (
      <div className="telos-chat-context">
        <SessionWorkLink taskId={context.itemId} />
        {context.leadConversationId && (
          <Link to={`/chat/${encodeURIComponent(context.leadConversationId)}`}>
            Return to lead chat
          </Link>
        )}
        <TelosLinkedContext context={context} />
      </div>
    );
  }
  return (
    <div className="telos-chat-context">
      {source.status === 'ready' ? (
        <SessionWorkLink taskId={source.itemId} />
      ) : (
        <span role="status">
          {source.status === 'loading'
            ? 'Opening original exchange…'
            : 'Original exchange unavailable'}
        </span>
      )}
    </div>
  );
}
