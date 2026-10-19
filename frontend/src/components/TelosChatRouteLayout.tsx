import type { ReactNode } from 'react';
import type { TelosChatRoute } from '../hooks/useTelosChatRoute';
import { TelosChatFrame } from './TelosChatFrame';
import { TelosChatWorkTree } from './TelosChatWorkTree';
import { telosChatRows } from '../lib/telos-chat-rows';

export function TelosChatRouteLayout({
  route,
  conversationId,
  header,
  children,
}: {
  route: TelosChatRoute;
  conversationId: string | null;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <TelosChatFrame
      className="telos-chat-route-frame"
      linked={!!route.data && !!conversationId}
      conversationId={conversationId ?? ''}
      itemTitle={route.data?.record.summary ?? ''}
      chatCount={route.data ? telosChatRows(route.data.work).length : 0}
      onItem={route.onItem}
      onChats={route.onChats}
      header={header}
      tree={
        route.data && conversationId ? (
          <TelosChatWorkTree conversationId={conversationId} data={route.data} />
        ) : null
      }
    >
      {route.error && <p role="status">{route.error}</p>}
      {children}
    </TelosChatFrame>
  );
}
