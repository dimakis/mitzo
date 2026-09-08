import { useIsDesktop } from '../hooks/useMediaQuery';
import { ChatView } from '../pages/ChatView';
import { DesktopChatView } from '../pages/DesktopChatView';

/** Shared by the app and fixture preview so mobile uses the complete mobile screen. */
export function ResponsiveChatView() {
  return useIsDesktop() ? <DesktopChatView /> : <ChatView />;
}
