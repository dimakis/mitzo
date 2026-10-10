import { useMitzoStore } from '@mitzo/client/hooks';
import { ReviewerSheetHost } from './AddReviewerSheet';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { ChatView } from '../pages/ChatView';
import { DesktopChatView } from '../pages/DesktopChatView';
import { useInRouterContext, useSearchParams } from 'react-router-dom';
import { AgentProfileSelectionSchema, type AgentProfileSelection } from '@mitzo/protocol';

/** Shared by the app and fixture preview so mobile uses the complete mobile screen. */
export function ResponsiveChatView() {
  const routed = useInRouterContext();
  return routed ? <RoutedChatProfile /> : <ResponsiveChatBody />;
}
function RoutedChatProfile() {
  const [search] = useSearchParams();
  const initial = AgentProfileSelectionSchema.safeParse({
    profileId: search.get('reviewerProfile'),
    revision: Number(search.get('reviewerRevision')),
  });
  return <ResponsiveChatBody initialProfile={initial.success ? initial.data : undefined} />;
}
function ResponsiveChatBody({ initialProfile }: { initialProfile?: AgentProfileSelection }) {
  const desktop = useIsDesktop();
  const sessionId = useMitzoStore((state) => state.sessions.active);
  const screen = desktop ? <DesktopChatView /> : <ChatView />;
  return (
    <ReviewerSheetHost sessionId={sessionId} initialProfile={initialProfile}>
      {screen}
    </ReviewerSheetHost>
  );
}
