import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { operatorAuthMiddleware } from '../auth.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { ApiToolCatalog } from '../api-tool-catalog.js';
import { createAgentLibraryRouter } from '../agent-library-router.js';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type ConnectionSender,
} from '../credential-connections.js';
import { SymposiumCustodianController } from '../symposium-custodian-controller.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import { createCustodianIpcClient, serveCustodianController } from '../symposium-custodian-ipc.js';
class Channel extends EventEmitter {
  peer!: Channel;
  connected = true;
  send(message: unknown) {
    queueMicrotask(() => this.peer.emit('message', message));
    return true;
  }
}
it.each(['abort', 'timeout', 'disconnect'] as const)(
  'cancels retained-owner API verification before proof publication on %s',
  async (mode) => {
    const parent = new Channel(),
      child = new Channel();
    parent.peer = child;
    child.peer = parent;
    const library = new AgentLibraryStore(':memory:');
    const catalog = new ApiToolCatalog(':memory:');
    const store = new CredentialConnectionStore(':memory:');
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn<ConnectionSender>(async (_request, currentSignal) => {
      signal = currentSignal;
      await waiting;
      return {
        status: 200,
        body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
      };
    });
    const service = new CredentialConnections(
      store,
      {
        save: async () => ({ service: 'fixture', account: 'fixture' }),
        link: vi.fn(),
        read: async () => 'fixture',
        remove: vi.fn(),
      },
      send,
    );
    const connection = await service.create(
      {
        label: 'Fixture',
        serviceTemplate: 'home-assistant',
        endpoint: 'https://ha.example.com',
        auth: { kind: 'bearer' },
        methods: ['GET'],
        paths: ['/api/'],
      },
      { secret: 'fixture' },
    );
    const draft = catalog.save(
      {
        id: randomUUID(),
        expectedVersion: 0,
        configuration: {
          template: 'home-assistant.state@1',
          label: 'Office',
          connectionId: connection.id,
          entityId: 'sensor.office',
        },
      },
      service,
    );
    const app = express();
    app.use(express.json(), operatorAuthMiddleware);
    app.use(
      '/api/agent-library',
      createAgentLibraryRouter(library, { apiTools: () => ({ catalog, service }) }),
    );
    const owner = new SymposiumCustodianController({
      pause: vi.fn(),
      resume: vi.fn(),
      invalidate: vi.fn(),
      drain: async () => {},
      dispatch: (command, assertCurrent, approval, signal) =>
        dispatchCustodianHttp(app, command, assertCurrent, approval, signal),
    });
    const stopped = serveCustodianController(parent, owner);
    let drained = false;
    void stopped.then(() => {
      drained = true;
    });
    const client = createCustodianIpcClient(child, {
      requestTimeoutMs: mode === 'timeout' ? 500 : 60_000,
    });
    const abort = new AbortController();
    const outcome = client
      .request(
        {
          operation: 'library.apiVerify',
          requestId: 'verify',
          body: { id: draft.id, version: draft.version },
          query: {},
          authorization: {
            id: 'api-verifier-' + mode,
            expiresAt: Date.now() + 60_000,
            recentUntil: Date.now() + 60_000,
          },
        },
        undefined,
        abort.signal,
      )
      .catch((error: Error) => error.message);
    try {
      await vi.waitFor(() => expect(signal).toBeDefined());
      for (const frame of [
        { kind: 'advice-request-cancel', epoch: 2, requestId: 'verify' },
        { kind: 'advice-request-cancel', epoch: 1, requestId: 'unrelated' },
        { kind: 'read-request-cancel', epoch: 1, requestId: 'verify' },
      ])
        child.send(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signal!.aborted).toBe(false);
      if (mode === 'abort') abort.abort();
      if (mode === 'disconnect') {
        child.emit('disconnect');
        parent.emit('disconnect');
      }
      await vi.waitFor(() => expect(signal!.aborted).toBe(true));
      expect(await outcome).toMatch(mode === 'disconnect' ? /channel unavailable/ : /cancelled/);
      expect(() => catalog.publish(draft.id, draft.version, service)).toThrow(/verif/i);
      if (mode !== 'disconnect') parent.emit('disconnect');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      release();
      await stopped;
      expect(service.sessions(connection.id)).toEqual([]);
      expect(() => catalog.publish(draft.id, draft.version, service)).toThrow(/verif/i);
    } finally {
      release();
      child.emit('disconnect');
      parent.emit('disconnect');
      await outcome;
      await stopped;
      catalog.close();
      library.close();
      store.close();
    }
  },
);
