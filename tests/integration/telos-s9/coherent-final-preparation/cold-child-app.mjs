// Dedicated offline cold process: real App/owners, no database birth/enrollment
// and no authority shim. It can read retained receipts and replay exact commands
// through the original App routes. Any accidental provider execution is counted.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.cwd();
const config = JSON.parse(readFileSync(process.env.S9_COHERENT_COLD_CONFIG, 'utf8'));
register(new URL('./coherent-child-loader.mjs', import.meta.url), { data: { root } });
globalThis.fetch = async () => {
  throw Error('No external network or model call');
};
const source = (relative) => import(pathToFileURL(join(root, relative)).href);
const native = await source('server/codex-app-server-client.ts');
let providerLaunches = 0;
const metadata = async (method) => {
  if (method === 'account/read')
    return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
  if (method === 'config/read') return { config: {} };
  if (method === 'model/list')
    return {
      data: [
        {
          model: 'fixture-model',
          displayName: 'Offline fixture',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        },
      ],
      nextCursor: null,
    };
  throw Error('Cold retained command must not execute a provider turn: ' + method);
};
native.CodexAppServerClient.launchPreflight = () => ({
  initialize: async () => {},
  request: metadata,
  notify() {},
  close() {},
});
for (const method of ['launch', 'launchOpenShell', 'launchIsolated'])
  native.CodexAppServerClient[method] = () => {
    providerLaunches++;
    throw Error('No cold replay provider launch');
  };
const profiles = await source('server/account-profiles.ts');
await profiles.loadAccountProfiles().refresh(true);
const application = await source('server/app.ts');
const chat = await source('server/chat.ts');
const auth = await source('server/auth.ts');
auth.setAuthRevocationStore(chat.eventStore);
const authenticated = await auth.authenticateToken(config.token);
if (!authenticated || authenticated.id !== config.operatorId)
  throw Error('Original retained synthetic operator required');
const { installJoinedChatTransport } = await import('./joined-browser-target.ts');
const connections = await installJoinedChatTransport(
  application.app,
  chat,
  application.chatSseRegistry,
);
const { SseTransport } = await source('server/sse-transport.ts');
const transportAuth = await source('server/transport-auth-ownership.ts');
const libraryTransport = await source('server/agent-library-transport.ts');
const unbind = libraryTransport.bindAgentLibraryTransport(config.connectionId, authenticated);
transportAuth.claimTransportConnection(config.connectionId, authenticated.id);
application.chatSseRegistry.add(
  config.connectionId,
  { write: () => true, end() {}, writableEnded: false },
  authenticated.id,
);
connections.register(
  config.connectionId,
  new SseTransport(config.connectionId, application.chatSseRegistry),
);
const { TaskOrchestrator } = await source('server/task-orchestrator.ts');
application.setOrchestrator(
  new TaskOrchestrator({
    store: application.taskStore,
    getClientId: () => {
      throw Error('No legacy worker selection');
    },
    setTaskContext: () => {
      throw Error('No legacy context mutation');
    },
    clearTaskContext() {},
    broadcastStatus() {},
    broadcastTasks() {},
  }),
);
const recovery = {
  stale: chat.eventStore.recoverStaleSessions(),
  orphaned: chat.eventStore.recoverOrphanedExecutions(),
};
chat.eventStore.recoverPendingSendCommands();
const server = application.app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string' || [3100, 3101, 3190].includes(address.port))
    throw Error('Owned private IPv4 address required');
  process.send?.({
    type: 'ready',
    pid: process.pid,
    port: address.port,
    operatorId: authenticated.id,
    recovery,
  });
});
process.on('message', async (message) => {
  if (message?.type === 'snapshot') {
    try {
      const { TelosItemStore } = await source('server/telos-item-store.ts');
      const { TelosWorkStore } = await source('server/telos-work-store.ts');
      const items = new TelosItemStore(process.env.TELOS_DB_PATH);
      const { isAvailableTelosWorkConversation, isAvailableTelosSourceConversation } = await source(
        'server/telos-work-conversation.ts',
      );
      const work = new TelosWorkStore(process.env.TELOS_DB_PATH, {
        ordinaryConversation: (id) =>
          isAvailableTelosWorkConversation(chat.eventStore.getSession(id)),
        sourceConversation: (id) =>
          isAvailableTelosSourceConversation(chat.eventStore.getSession(id)),
      });
      try {
        const receipt = config.publication
          ? work
              .mainPublicationsForHost()
              .existingForHost(config.publication.input, config.publication.durable.pins.authority)
          : null;
        process.send?.({
          type: 'snapshot',
          id: message.id,
          value: {
            pid: process.pid,
            providerLaunches,
            task: application.taskStore.get(config.taskId),
            items: config.itemIds.map((id) => items.read(id)),
            sessions: config.sessionIds.map((id) => chat.eventStore.getSession(id)),
            publication: receipt,
          },
        });
      } finally {
        work.close();
        items.close();
      }
    } catch (error) {
      process.send?.({ type: 'snapshot', id: message.id, error: String(error) });
    }
  }
  if (message?.type === 'close-private-app') {
    try {
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      application.chatSseRegistry.remove(config.connectionId);
      transportAuth.releaseTransportConnection(config.connectionId, authenticated.id);
      unbind();
      auth.revokeAuthSession(authenticated);
      if ((await auth.authenticateToken(config.token)) !== null)
        throw Error('Final signed-session revocation was not retained');
      if (!process.send) throw Error('Owned parent IPC required for final auth release');
      await new Promise((done, reject) =>
        process.send(
          { type: 'auth-revoked', operatorId: authenticated.id, confirmed: true },
          (error) => (error ? reject(error) : done()),
        ),
      );
      (await source('server/agent-library-runtime.ts')).closeAgentLibrary();
      (await source('server/repository-workspace-runtime.ts')).closeIdleRepositoryWorkspaces();
      application.taskStore.close();
      chat.eventStore.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }
});
