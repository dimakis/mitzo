import { useMitzoStore } from '@mitzo/client/hooks';
import { ReviewerSheetHost } from './AddReviewerSheet';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { ChatView } from '../pages/ChatView';
import { DesktopChatView } from '../pages/DesktopChatView';

/** Shared by the app and fixture preview so mobile uses the complete mobile screen. */
export function ResponsiveChatView() {
  const desktop = useIsDesktop();
  const sessionId = useMitzoStore((state) => state.sessions.active);
  const screen = desktop ? <DesktopChatView /> : <ChatView />;
  return sessionId ? (
    <ReviewerSheetHost key={sessionId} sessionId={sessionId}>
      {screen}
    </ReviewerSheetHost>
  ) : (
    screen
  );
}
