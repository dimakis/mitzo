import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { routeLegacyChatSend } from '../legacy-chat-delivery.js';
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { SkillRegistry } from '../skills.js';
import { NativeCommandRegistry } from '../native-commands.js';
import { resolveSlashCommand } from '../slash-commands.js';
import { buildSkillRegistry } from '../app.js';
import { startChat, stopChat } from '../chat.js';
import { dispatchV2Message } from '../ws-handler-v2.js';

vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn(),
  isAllowedPath: vi.fn(),
  NATIVE_COMMAND_NAMES: new Set(['skills']),
}));
vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  stopChat: vi.fn(),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  preflightChatCommand: vi.fn(),
  preflightStartupProviderCommand: vi.fn(),
  nativeStartupSessionId: vi.fn(),
  isActive: vi.fn(),
  reattachChat: vi.fn(),
  BASE_REPO: '/offline',
}));

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function skills(missingBody: boolean) {
  const registry = new SkillRegistry({});
  if (missingBody) {
    vi.spyOn(registry, 'get').mockReturnValue({
      name: 'empty',
      description: 'Empty skill',
      scope: 'repo',
      filePath: '/offline/SKILL.md',
    });
    vi.spyOn(registry, 'getBody').mockReturnValue('');
  }
  return registry;
}

it.each(
  [false, true].flatMap((missingBody) =>
    [null, 'ordinary'].map((sessionId) => ({ missingBody, sessionId })),
  ),
)(
  'correlates V2 slash refusal before provider acceptance (missingBody:$missingBody session:$sessionId)',
  async ({ missingBody, sessionId }) => {
    const store = new EventStore(':memory:');
    cleanup.push(() => store.close());
    if (sessionId) store.upsertSession({ sessionId });
    const registry = skills(missingBody);
    vi.mocked(buildSkillRegistry).mockReturnValue(registry);
    const nativeCommands = new NativeCommandRegistry();
    const execute = vi.spyOn(nativeCommands, 'execute');
    const transport = { send: vi.fn(), isOpen: () => true };
    const connRegistry = new ConnectionRegistry();
    connRegistry.register('viewer', transport);
    const prompt = missingBody ? '/empty' : '/not-a-command';
    const resolution = resolveSlashCommand(prompt, registry, new Set(['skills']));
    expect(resolution.type).toBe('error');
    if (resolution.type !== 'error') throw Error('Expected real slash resolution refusal');
    await dispatchV2Message(
      'viewer',
      transport,
      JSON.stringify({
        type: 'send',
        sessionId,
        prompt,
        clientMsgId: 'rejected-command',
      }),
      { eventStore: store, connRegistry, sessionRegistry: new SessionRegistry(), nativeCommands },
    );
    expect(transport.send).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      error: resolution.message,
      clientMsgId: 'rejected-command',
      ...(sessionId ? { sessionId } : {}),
    });
    expect(startChat).not.toHaveBeenCalled();
    expect(stopChat).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(connRegistry.get('viewer')?.activeSession).toBeNull();
    expect(sessionId ? store.getSessionEvents(sessionId) : []).toEqual([]);
  },
);

// Exercise the existing legacy Send callback without importing index's service bootstrap.
function legacySend(dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('../index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'withSpan' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'ws.send'
    )
      callback = node.arguments[2];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw Error('Legacy Send callback not found');
  const code = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const send = runInNewContext(code, dependencies) as (span: {
    setAttribute: ReturnType<typeof vi.fn>;
  }) => void;
  send({ setAttribute: vi.fn() });
}

it.each(
  [false, true].flatMap((missingBody) =>
    ['new', 'resume', 'active'].map((route) => ({ missingBody, route })),
  ),
)(
  'correlates actual legacy slash refusal before routing (missingBody:$missingBody route:$route)',
  ({ missingBody, route }) => {
    const skillRegistry = skills(missingBody);
    const sessionId =
      route === 'new' ? undefined : route === 'active' ? 'active-ordinary' : 'resumed-ordinary';
    const prompt = missingBody ? '/empty' : '/not-a-command';
    const resolution = resolveSlashCommand(prompt, skillRegistry, new Set(['skills']));
    if (resolution.type !== 'error') throw Error('Expected real slash resolution refusal');
    const transport = { send: vi.fn() };
    const execute = vi.fn(),
      observe = vi.fn(),
      sendActive = vi.fn();
    legacySend({
      msg: {
        prompt,
        clientMsgId: 'legacy-command',
        resume: route === 'active' ? 'ignored-resume' : sessionId,
      },
      clientId: 'legacy-viewer',
      transport,
      routeLegacyChatSend,
      eventStore: { getSessionEvents: () => [], getUnsettledSymposiumSeatExecutions: () => [] },
      registry: { get: () => (route === 'active' ? { sessionId, cwd: '/offline' } : undefined) },
      isActive: () => route === 'active',
      BASE_REPO: '/offline',
      buildSkillRegistry: () => skillRegistry,
      resolveSlashCommand,
      NATIVE_COMMAND_NAMES: new Set(['skills']),
      nativeCommands: { execute },
      tryRouteToActiveSession: observe,
      sendToActiveChat: sendActive,
      startChat,
    });
    expect(transport.send).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      error: resolution.message,
      clientMsgId: 'legacy-command',
      ...(sessionId ? { sessionId } : {}),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(sendActive).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  },
);
