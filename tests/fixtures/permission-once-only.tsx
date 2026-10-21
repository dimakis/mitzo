import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MitzoNotification, PermissionRequest } from '@mitzo/protocol';
import { PermissionBanner } from '../../frontend/src/components/PermissionBanner';
import { RequestDetail } from '../../frontend/src/pages/NotificationsView';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';

declare global {
  interface Window {
    fixtureResponses: unknown[][];
  }
}
window.fixtureResponses = [];
const query = new URLSearchParams(location.search);
const allowance = query.get('allow');
const kind = query.get('kind') ?? 'ordinary';
const request = {
  permId: 'component-permission',
  sessionId: 'component-session',
  toolName: 'PublishReviewedPullRequest',
  title: 'Merge this reviewed PR into main?',
  description: 'Approve the displayed reviewed change for this single publication request.',
  toolInput: 'Reviewed source: ' + 'exact-source-'.repeat(240) + '\nEND OF REVIEWED REQUEST',
  approvalScope: kind === 'conversation' ? ('conversation' as const) : ('request' as const),
  ...(kind === 'source' ? { reviewKind: 'telos_source' as const } : {}),
  ...(kind === 'question'
    ? {
        questions: [
          {
            id: 'q1',
            header: 'Next step',
            multiSelect: false,
            question: 'Choose the next step',
            options: [{ label: 'Proceed', description: '' }],
          },
        ],
      }
    : {}),
  ...(allowance === 'missing' ? {} : { allowSessionGrant: allowance === 'true' }),
  sessionGrantDescription:
    kind === 'conversation'
      ? undefined
      : 'Allow for session keeps this approval until the session ends.',
} satisfies PermissionRequest;
const item: MitzoNotification = {
  id: 'permission:component-permission',
  kind: 'approval',
  title: request.title,
  body: request.description,
  sessionId: request.sessionId,
  permId: request.permId,
  createdAt: Date.now(),
  expiresAt: Date.now() + 600000,
  readAt: null,
  resolution: null,
  resolvedAt: null,
  request,
};
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    {query.get('view') === 'notification' ? (
      <RequestDetail
        item={item}
        busy={false}
        onRespond={(...args) => window.fixtureResponses.push(args)}
      />
    ) : (
      <PermissionBanner
        {...request}
        expiresAt={item.expiresAt}
        onRespond={(...args) => window.fixtureResponses.push(args)}
      />
    )}
  </MemoryRouter>,
);
