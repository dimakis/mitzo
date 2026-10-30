import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { vi } from 'vitest';
import type WebSocket from 'ws';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type ConnectionSender,
} from '../../credential-connections.js';
import { setCredentialConnectionsRuntime } from '../../credential-connections-runtime.js';
import { dashboardExchange } from '../../home-assistant-dashboard.js';
import { websocketRequest, type ConnectionSocketFactory } from '../../credential-websocket.js';
import { AcceptedKnowledgeSource } from '../../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../../knowledge-draft-store.js';
import { installKnowledgeDraftRuntime } from '../../session-knowledge-tools.js';

/** Only the OS vault, external socket and HTTPS peers are synthetic. */
export async function localMacToolServices(
  root: string,
  cleanup: Array<() => void | Promise<void>>,
) {
  const store = new CredentialConnectionStore(':memory:');
  const secret = 'SECRET_SYNTHETIC_KEYCHAIN_TOKEN';
  const vault = {
    save: vi.fn(async () => ({ service: 'offline', account: 'ha' })),
    read: vi.fn(async () => secret),
    remove: vi.fn(async () => {}),
    link: vi.fn(async () => ({ service: 'offline', account: 'ha' })),
  };
  const http = vi.fn<ConnectionSender>(async (input) => {
    await input.assertRuntimeCurrent?.();
    if (input.headers.Authorization !== `Bearer ${secret}`) throw Error('Missing private auth');
    return {
      status: 200,
      body: JSON.stringify({ entity_id: 'light.study', state: 'off', echo: secret }),
    };
  });
  const frames: Array<Record<string, unknown>> = [];
  const dashboard = { config: { views: [{ title: 'Home', cards: [] }] } };
  let beforeFrame: (() => void) | undefined;
  const createSocket: ConnectionSocketFactory = (_url, options) => {
    class Socket extends EventEmitter {
      send(text: string) {
        const m = JSON.parse(text);
        frames.push(m);
        beforeFrame?.();
        const reply =
          m.type === 'auth'
            ? { type: 'auth_ok' }
            : {
                id: m.id,
                type: 'result',
                success: true,
                result:
                  m.type === 'lovelace/config/save'
                    ? ((dashboard.config = m.config), null)
                    : m.type === 'lovelace/config'
                      ? dashboard.config
                      : m.type === 'lovelace/dashboards/list'
                        ? [{ url_path: 'home-dashboard' }]
                        : { ok: true },
              };
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(reply)), false));
      }
      terminate() {}
    }
    const socket = new Socket();
    queueMicrotask(() => {
      socket.emit('open');
      if (!options.headers?.Authorization)
        socket.emit('message', Buffer.from('{"type":"auth_required"}'), false);
    });
    return socket as unknown as WebSocket;
  };
  const service = new CredentialConnections(
    store,
    vault,
    http,
    (input, signal) => dashboardExchange(input, signal, createSocket),
    (input, signal) => websocketRequest(input, signal, createSocket),
  );
  const connection = await service.create(
    {
      label: 'Offline Home Assistant',
      serviceTemplate: 'home-assistant',
      endpoint: 'https://ha.example.test',
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['GET', 'POST'],
      homeAssistantDashboards: 'read-write',
      websocket: { path: '/api/websocket', authentication: { kind: 'headers' } },
    },
    { secret },
  );
  setCredentialConnectionsRuntime(service);
  cleanup.push(() => {
    setCredentialConnectionsRuntime(null);
    store.close();
  });
  const knowledge = join(root, 'accepted-knowledge');
  await mkdir(join(knowledge, 'people'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', knowledge, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(
    join(knowledge, 'people/person.md'),
    '# Accepted person\nOriginal accepted knowledge.\n',
  );
  git('add', '.');
  git('commit', '-qm', 'accepted');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(knowledge, 'people/person.md'), '# Dirty task file must not be returned\n');
  const source = new AcceptedKnowledgeSource(knowledge, 'refs/remotes/origin/main', ['people']);
  const drafts = new KnowledgeDraftStore(':memory:');
  const release = installKnowledgeDraftRuntime(async () => ({
    source,
    store: drafts,
    sourceIdentity: 'offline:accepted@main',
    refresh: async () => {},
  }));
  cleanup.push(() => {
    release();
    drafts.close();
  });
  return {
    store,
    service,
    vault,
    http,
    connection,
    frames,
    dashboard,
    revision,
    source,
    drafts,
    setBeforeFrame: (value: (() => void) | undefined) => {
      beforeFrame = value;
    },
  };
}
