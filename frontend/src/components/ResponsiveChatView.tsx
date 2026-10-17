import { TelosSourceNavigationProvider } from '../hooks/TelosSourceNavigation';
import { ChatRuntimeDraftProvider } from '../hooks/ChatRuntimeDraftProvider';
import { useMitzoStore } from '@mitzo/client/hooks';
import { ReviewerSheetHost } from './AddReviewerSheet';
import { OrdinaryCollaborationHost } from './OrdinaryCollaborationEntry';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { ChatView } from '../pages/ChatView';
import { DesktopChatView } from '../pages/DesktopChatView';
import { useInRouterContext, useSearchParams, useParams } from 'react-router-dom';
import { AgentProfileSelectionSchema, type AgentProfileSelection } from '@mitzo/protocol';

/** Shared by the app and fixture preview so mobile uses the complete mobile screen. */
export function ResponsiveChatView() {
  const routed = useInRouterContext();
  return routed ? <RoutedChatProfile /> : <ResponsiveChatBody />;
}
function RoutedChatProfile() {
  const [search] = useSearchParams();
  const { sessionId } = useParams<{ sessionId: string }>();
  const initial = AgentProfileSelectionSchema.safeParse({
    profileId: search.get('reviewerProfile'),
    revision: Number(search.get('reviewerRevision')),
  });
  return (
    <ResponsiveChatBody
      initialProfile={initial.success ? initial.data : undefined}
      requestedDraftId={search.get('draft')}
      sourceRequest={
        sessionId && search.get('telosItem') && search.get('telosSource')
          ? {
              conversationId: sessionId,
              itemId: search.get('telosItem')!,
              snapshotId: search.get('telosSource')!,
            }
          : undefined
      }
    />
  );
}
function ResponsiveChatBody({
  initialProfile,
  requestedDraftId,
  sourceRequest,
}: {
  initialProfile?: AgentProfileSelection;
  requestedDraftId?: string | null;
  sourceRequest?: { conversationId: string; itemId: string; snapshotId: string };
}) {
  const desktop = useIsDesktop();
  const sessionId = useMitzoStore((state) => state.sessions.active);
  const generation = useMitzoStore((state) => state.chatDraftRevision);
  const refreshKey = useMitzoStore(
    (state) => `${state.messages.messages.length}:${state.messages.running}`,
  );
  const screen = desktop ? <DesktopChatView /> : <ChatView />;
  return (
    <ChatRuntimeDraftProvider owner={`${sessionId ?? requestedDraftId ?? 'new'}:${generation}`}>
      <OrdinaryCollaborationHost sessionId={sessionId} refreshKey={refreshKey}>
        <ReviewerSheetHost sessionId={sessionId} initialProfile={initialProfile}>
          <TelosSourceNavigationProvider request={sourceRequest} sessionId={sessionId}>
            {screen}
          </TelosSourceNavigationProvider>
        </ReviewerSheetHost>
      </OrdinaryCollaborationHost>
    </ChatRuntimeDraftProvider>
  );
}
