import { createCustodianIpcClient, type CustodianChannel } from '../../symposium-custodian-ipc.js';
import { SessionRegistry, ConnectionRegistry, resolvePending } from '@mitzo/harness';
import { publicationControllerApproval } from '../../symposium-publication-approval.js';
const registry = new SessionRegistry(),
  connections = new ConnectionRegistry();
connections.register('browser', {
  isOpen: () => true,
  send: (event) => {
    if (event.type === 'permission_request') resolvePending(String(event.permId), 'once');
  },
});
connections.watch('browser', 'session');
const approve = publicationControllerApproval(
  registry,
  (_id, jti) => jti === 'synthetic-test-operator',
  'session',
  'synthetic-test-operator',
  'browser',
  connections,
)!;
const client = createCustodianIpcClient(process as unknown as CustodianChannel);
try {
  const result = await client.request(
    {
      requestId: 'process-request',
      operation: 'publication.publish',
      sessionId: 'session',
      body: {
        grantId: 'grant',
        bindingHash: 'a'.repeat(64),
        turnId: 'turn',
        idempotencyKey: 'operation',
        baseBranch: 'main',
        title: 'Reviewed',
        body: 'Reviewed change',
        draft: true,
      },
      query: {},
      authorization: { id: 'synthetic-test-operator', expiresAt: Date.now() + 10000 },
    },
    approve,
  );
  process.send?.({ kind: 'test-result', result });
} catch {
  process.send?.({ kind: 'test-failure' });
} finally {
  registry.dispose();
  connections.dispose();
  process.disconnect();
}
