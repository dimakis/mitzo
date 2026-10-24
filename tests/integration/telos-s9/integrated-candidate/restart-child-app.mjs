// Dedicated test child. Never imports index.ts or starts host/runtime services.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { register } from 'node:module';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { createServer } from 'node:http';
const config = JSON.parse(readFileSync(process.env.S9_RESTART_CONFIG, 'utf8'));
const root = process.cwd();
const effect = (kind, detail = {}) =>
  appendFileSync(
    config.effectsPath,
    JSON.stringify({ kind, generation: config.generation, pid: process.pid, ...detail }) + '\n',
  );
register(new URL('./restart-child-loader.mjs', import.meta.url), { data: { root } });
globalThis.fetch = async () => {
  throw Error('No external network/model calls in restart child');
};
const native = await import(pathToFileURL(resolve(root, 'server/codex-app-server-client.ts')).href);
let launched = 0;
const externalRpc = (lifecycle) => {
  let threadId = `restart-native-${config.generation}-${++launched}`,
    turn = 0;
  return {
    initialize: async () => {},
    request: async (method, params) => {
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
      if (method === 'thread/start' || method === 'thread/resume') {
        threadId = params?.threadId ?? threadId;
        effect(method, { threadId });
        return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
      }
      if (method === 'turn/start') {
        const turnId = `${threadId}-turn-${++turn}`;
        effect(method, { threadId, turnId });
        // Deliberately no terminal notification: abrupt exit loses the result.
        return { turn: { id: turnId } };
      }
      if (method === 'turn/interrupt') {
        effect(method, { threadId });
        return {};
      }
      throw Error('Unexpected external native RPC: ' + method);
    },
    notify() {},
    respond() {},
    close() {
      effect(lifecycle ? 'native.close' : 'preflight.close', { threadId });
      lifecycle?.onClose?.(Error('Offline native closed'));
    },
  };
};
native.CodexAppServerClient.launchIsolated = (_home, _env, lifecycle) => {
  effect('native.launch');
  return externalRpc(lifecycle);
};
native.CodexAppServerClient.launchPreflight = () => externalRpc();
for (const method of ['launch', 'launchOpenShell'])
  native.CodexAppServerClient[method] = () => {
    throw Error('Alternate native process forbidden');
  };
const profiles = await import(pathToFileURL(resolve(root, 'server/account-profiles.ts')).href);
await profiles.loadAccountProfiles().refresh(true);
const application = await import(pathToFileURL(resolve(root, 'server/app.ts')).href);
const chat = await import(pathToFileURL(resolve(root, 'server/chat.ts')).href);
const auth = await import(pathToFileURL(resolve(root, 'server/auth.ts')).href);
auth.setAuthRevocationStore(chat.eventStore);
const authenticated = await auth.authenticateToken(config.token);
if (!authenticated) throw Error('Original signed synthetic auth must survive process generation');
const { installJoinedChatTransport } = await import('./joined-browser-target.ts');
const connections = await installJoinedChatTransport(
  application.app,
  chat,
  application.chatSseRegistry,
);
application.setTaskBroadcast((event) => {
  connections.broadcastAll(event);
  application.sseRegistry.broadcast('task_state', event);
});
// Reconstruct the existing native ledger owner before accepting HTTP work.
const nativeOwners = await import(
  pathToFileURL(resolve(root, 'server/codex-chat-session.ts')).href
);
nativeOwners.getCodexConversationStore();
// Same production startup recovery owners used by index.ts, with no host startup.
const startupRecovery = {
  stale: chat.eventStore.recoverStaleSessions(),
  orphaned: chat.eventStore.recoverOrphanedExecutions(),
};
chat.eventStore.recoverPendingSendCommands();
// Read-only diagnostic through the same real protected CLI owner as /api/todos.
let canonicalCliDiagnostic;
try {
  const { createWorkspaceRuntimeCommandRunner } = await import(
    pathToFileURL(resolve(root, 'server/protected-sdk-command.ts')).href
  );
  const runner = createWorkspaceRuntimeCommandRunner();
  if (!runner) throw Error('Expected enrolled filesystem boundary');
  const result = await runner(
    'python3',
    [join(process.env.REPO_PATH, 'command_center/todo_api.py'), '--list'],
    { cwd: root, env: process.env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  canonicalCliDiagnostic = {
    status: 'read',
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderr: result.stderr,
  };
} catch (error) {
  canonicalCliDiagnostic = {
    status: 'error',
    message: String(error),
    stderr: error.stderr ?? '',
    stdout: error.stdout ?? '',
  };
}
writeFileSync(
  join(dirname(config.effectsPath), `canonical-cli-${config.generation}.json`),
  JSON.stringify(canonicalCliDiagnostic, null, 2),
);
const server = createServer(application.app);
await new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', done);
});
const port = server.address().port;
if ([3100, 3101, 3190].includes(port)) throw Error('Reserved runtime port forbidden');
process.env.PORT = String(port);
process.on('message', async (message) => {
  if (message?.type !== 'snapshot') return;
  try {
    const { getOrdinaryWorkspaces } = await import(
      pathToFileURL(resolve(root, 'server/repository-workspace-runtime.ts')).href
    );
    const session = chat.eventStore.getSession(message.sessionId);
    const { getCodexConversationStore } = await import(
      pathToFileURL(resolve(root, 'server/codex-chat-session.ts')).href
    );
    const nativeStore = getCodexConversationStore();
    const workspace = session?.ordinaryWorkspaceId
      ? getOrdinaryWorkspaces(true).getOrdinaryWorkspace(session.ordinaryWorkspaceId)
      : null;
    process.send?.({
      type: 'snapshot',
      id: message.id,
      value: {
        native: {
          conversation: nativeStore.read(message.sessionId, session.accountBinding),
          commands: nativeStore.commands(message.sessionId, session.accountBinding),
        },
        pid: process.pid,
        generation: config.generation,
        session,
        runtimeBinding: chat.eventStore.getSessionRuntimeBinding(message.sessionId),
        workspace,
        preparation: workspace
          ? chat.eventStore.getOrdinaryWorkspaceSessionPreparation(workspace.allocationOperationId)
          : null,
        admission: chat.eventStore.getOrdinaryCommandAdmission(message.commandId),
        events: chat.eventStore.getSessionEvents(message.sessionId),
        tasks: application.taskStore.getTree(),
        activeSessionIds: [...chat.registry.entries()].map(([, s]) => s.sessionId),
      },
    });
  } catch (e) {
    process.send?.({ type: 'snapshot', id: message.id, error: String(e) });
  }
});
process.send?.({
  type: 'ready',
  pid: process.pid,
  generation: config.generation,
  port,
  authId: authenticated.id,
  statePaths: {
    repo: process.env.REPO_PATH,
    canonicalDb: process.env.TELOS_DB_PATH,
    nativeCustody: process.env.MITZO_CODEX_PRIVATE_DIR,
    accountProfiles: process.env.MITZO_ACCOUNT_PROFILES_FILE,
    taskDb: application.taskStore.getDatabase().name,
  },
  startupRecovery,
  owners: [
    'App/REST',
    'EventStore',
    'TaskStore/WorkloadStore',
    'SessionRegistry',
    'ConnectionRegistry',
    'SSE',
    'auth revocations',
    'ordinary workspace custody',
    'native conversation/command ledger',
    'native driver (lazy on explicit command)',
  ],
  exclusions: ['index.ts host services', 'production bundle', 'real native/provider process'],
});
