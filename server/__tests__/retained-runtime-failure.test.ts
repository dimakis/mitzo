import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import { deliverRetainedSessionEvent } from '../query-loop.js';
import { EventStore } from '../event-store.js';
import { reportRetainedRuntimeFailure } from '../retained-runtime-failure.js';
import { SessionRuntimeError } from '../session-runtime-error.js';
import { replayError, recordAcceptedReplaySession } from '../public-replay-error.js';
it('leaves an unsaved input failure to its original startup reporter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-unsaved-error-'));
  const store = new EventStore(join(dir, 'events.db'));
  const send = vi.fn();
  try {
    store.upsertSession({ sessionId: 'session', cwd: dir });
    reportRetainedRuntimeFailure({
      store,
      sessionId: 'session',
      commandId: 'not-echoed',
      onlyIfSaved: true,
      transport: { isOpen: () => true, send },
      error: new SessionRuntimeError('input_not_dispatched'),
    });
    expect(
      store.getSessionEvents('session').filter((event) => event.type === 'error'),
    ).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('uses one reference and one durable report for the same unclassified failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-fallback-error-'));
  const store = new EventStore(join(dir, 'events.db'));
  try {
    store.upsertSession({ sessionId: 'session', cwd: dir });
    const error = Error('private upstream contents');
    reportRetainedRuntimeFailure({ store, sessionId: 'session', error });
    reportRetainedRuntimeFailure({ store, sessionId: 'session', error });
    expect(
      store.getSessionEvents('session').filter((event) => event.type === 'error'),
    ).toHaveLength(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['codex', 'claude-sdk', 'gemini', 'responses'])(
  'retains a sanitized %s failure for current viewers and history without failing saved input',
  (engine) => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-retained-error-'));
    const store = new EventStore(join(dir, 'events.db'));
    try {
      store.upsertSession({ sessionId: engine, cwd: dir });
      store.insertSendCommand('saved', engine, { text: 'offline' });
      const original = store.getSendCommand('saved');
      store.append(engine, 'user_message', {
        v: 2,
        type: 'user_message',
        messageId: 'saved',
        text: 'offline',
      });
      const failure = new SessionRuntimeError('unsettled_effects', {
        cause: Error('secret /private/path'),
      });
      const phone = { isOpen: () => true, send: vi.fn() };
      const laptop = { isOpen: () => true, send: vi.fn() };
      const source = { transport: phone, observers: new Set([laptop]) };
      reportRetainedRuntimeFailure({
        store,
        sessionId: engine,
        session: source,
        commandId: 'saved',
        error: failure,
      });
      reportRetainedRuntimeFailure({
        store,
        sessionId: engine,
        session: source,
        commandId: 'saved',
        error: failure,
      });
      expect(phone.send).toHaveBeenCalledOnce();
      expect(laptop.send).toHaveBeenCalledOnce();
      const accepted = new Map<string, Set<string>>();
      const events = store.getSessionEvents(engine);
      events.forEach((event) => recordAcceptedReplaySession(event, accepted));
      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toHaveLength(1);
      expect(replayError(errors[0], accepted)).toMatchObject({
        clientMsgId: 'saved',
        message: expect.stringContaining(failure.diagnosticId),
      });
      expect(JSON.stringify(errors)).not.toContain('secret');
      expect(store.getSendCommand('saved')).toEqual(original);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('isolates a throwing moved driver and delivers one durable diagnostic to healthy observers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-moved-diagnostic-'));
  const store = new EventStore(join(dir, 'events.db'));
  const registry = new SessionRegistry();
  const observer = { isOpen: () => true, send: vi.fn() };
  try {
    store.upsertSession({ sessionId: 'session', cwd: dir });
    registry.register('moved-driver', {
      transport: {
        isOpen: () => true,
        send: () => {
          throw Error('socket closed');
        },
      },
      abortController: new AbortController(),
      mode: 'auto',
      sessionAllowList: new Set(),
    });
    const session = registry.get('moved-driver')!;
    session.sessionId = 'session';
    session.observers.add(observer);
    const error = new SessionRuntimeError('callbacks_failed');
    const report = () =>
      reportRetainedRuntimeFailure({
        store,
        sessionId: 'session',
        session,
        error,
        deliver: (event) => deliverRetainedSessionEvent(event, 'original-driver', registry),
      });
    expect(report).not.toThrow();
    report();
    expect(observer.send).toHaveBeenCalledOnce();
    const events = store.getSessionEvents('session').filter((event) => event.type === 'error');
    expect(events).toHaveLength(1);
    expect(observer.send.mock.calls[0][0]).toMatchObject({
      seq: events[0].seq,
      runtimeFailure: error.telemetry(),
    });
  } finally {
    registry.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
