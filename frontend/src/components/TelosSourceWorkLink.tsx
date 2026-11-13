import { useTelosSourceNavigation } from '../hooks/useTelosSourceNavigation';
import { SessionWorkLink } from './SessionWorkLink';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  TelosWorkRoleContextSelectionSchema,
  TelosWorkRolePresentationRefSchema,
  type TelosWorkRoleContextReview,
  type TelosWorkRoleContextSelection,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { TelosLinkedContext } from './TelosLinkedContext';
import { readTelosRolePresentation } from '../lib/telos-role-presentation';
import { z } from 'zod';

const Coordination = z.object({
  itemId: z.string(),
  role: z.string(),
  assignment: z.enum(['current', 'previous', 'unassigned']),
  reportingTo: z
    .object({
      conversationId: z.string().min(1).max(200),
      availability: z.string(),
      executionPhase: z.string().nullable().optional(),
      executionTerminalReason: z.string().nullable().optional(),
    })
    .nullable(),
  diagnostic: z.string().nullable().optional(),
});

/** The compact item row is shared by the mobile and desktop ordinary chat. */
export function TelosSourceWorkLink({
  conversationId,
  hideItemLink = false,
}: { conversationId?: string; hideItemLink?: boolean } = {}) {
  const source = useTelosSourceNavigation();
  const [role, setRole] = useState<{
    conversationId: string;
    context?: TelosWorkRoleContextSelection;
    display?: Pick<TelosWorkRoleContextReview, 'presentation' | 'presentationRef'>;
    leadConversationId?: string;
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
        let display:
          Pick<TelosWorkRoleContextReview, 'presentation' | 'presentationRef'> | undefined;
        if (metadata.telosWorkRolePresentation !== undefined) {
          if (!context) throw new Error('Original role context required for labels');
          const retained = metadata.telosWorkRolePresentation;
          display = {
            presentation: readTelosRolePresentation(
              context,
              retained?.presentation,
              retained?.presentationRef,
            ),
            presentationRef: TelosWorkRolePresentationRefSchema.parse(retained?.presentationRef),
          };
        }
        const coordination = Coordination.safeParse(metadata.telosSessionCoordination);
        const current = coordination.success ? coordination.data : undefined;
        const leadConversationId =
          context &&
          current?.itemId === context.itemId &&
          current.role === context.role &&
          current.assignment === 'current' &&
          !current.diagnostic &&
          current.reportingTo?.availability === 'available' &&
          current.reportingTo.executionPhase !== 'STOPPING' &&
          !(
            current.reportingTo.executionPhase === 'TERMINAL' &&
            ['stopped', 'interrupted'].includes(current.reportingTo.executionTerminalReason ?? '')
          )
            ? current.reportingTo.conversationId
            : undefined;
        if (!controller.signal.aborted)
          setRole({ conversationId, context, display, leadConversationId });
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
        {!hideItemLink && <SessionWorkLink taskId={context.itemId} />}
        {role.leadConversationId ? (
          <Link to={`/chat/${encodeURIComponent(role.leadConversationId)}`}>
            Return to lead chat
          </Link>
        ) : context.role === 'worker' ? (
          <span role="status">Current lead unavailable. Review the assignment in linked work.</span>
        ) : null}
        <TelosLinkedContext context={context} {...role.display} />
      </div>
    );
  }
  return (
    <div className="telos-chat-context">
      {source.status === 'ready' ? (
        hideItemLink ? null : (
          <SessionWorkLink taskId={source.itemId} />
        )
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
