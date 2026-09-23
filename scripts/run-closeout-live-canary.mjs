#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const CLOSEOUT_PROMPT_PREFIX = 'The user has closed this session.';

export function liveCanaryConfig(env = process.env) {
  const accountId = env.MITZO_PROBE_ACCOUNT_ID?.trim();
  const model = env.MITZO_PROBE_MODEL?.trim();
  const reasoningEffort = env.MITZO_PROBE_REASONING_EFFORT?.trim();
  const passphrase = env.MITZO_PROBE_PASSPHRASE;
  if (!passphrase) throw new Error('MITZO_PROBE_PASSPHRASE is required');
  if (!accountId) throw new Error('MITZO_PROBE_ACCOUNT_ID is required');
  if (!model) throw new Error('MITZO_PROBE_MODEL is required');
  if (!/(?:^|-)luna(?:$|-)/i.test(model))
    throw new Error('MITZO_PROBE_MODEL must explicitly select a Luna model');
  if (!reasoningEffort) throw new Error('MITZO_PROBE_REASONING_EFFORT is required');
  if (env.MITZO_PROBE_ACKNOWLEDGE_NON_PRODUCTION !== '1')
    throw new Error('MITZO_PROBE_ACKNOWLEDGE_NON_PRODUCTION must equal 1');
  const acknowledgement = `${accountId}:${model}`;
  if (env.MITZO_PROBE_ACKNOWLEDGE_CHARGE !== acknowledgement)
    throw new Error(`MITZO_PROBE_ACKNOWLEDGE_CHARGE must equal ${acknowledgement}`);
  const timeoutMs = Number(env.MITZO_PROBE_TIMEOUT_MS || 180_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 130_000)
    throw new Error('MITZO_PROBE_TIMEOUT_MS must be at least 130000');
  return {
    baseUrl: env.MITZO_PROBE_URL || 'http://localhost:4310',
    passphrase,
    accountId,
    model,
    reasoningEffort,
    timeoutMs,
  };
}

export function parseSseChunk(buffer, chunk) {
  let pending = buffer + chunk;
  const messages = [];
  let boundary;
  while ((boundary = pending.indexOf('\n\n')) >= 0) {
    const frame = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data) messages.push(JSON.parse(data));
  }
  return { buffer: pending, messages };
}

export function createCloseoutTracker(sessionId) {
  const attempts = new Map();
  let closePromptSeen = false;
  let closeAcknowledged = false;
  let execution;
  let ended = false;
  let attemptMismatch;

  return {
    accept(message) {
      if (message.sessionId !== sessionId) return;
      if (message.type === 'session_close_ack' && message.accepted === true)
        closeAcknowledged = true;
      if (
        message.type === 'user_message' &&
        typeof message.text === 'string' &&
        message.text.startsWith(CLOSEOUT_PROMPT_PREFIX)
      )
        closePromptSeen = true;
      if (message.type === 'provider_attempt_state_changed') {
        const token = {
          executionId: message.executionId,
          generation: message.generation,
          attempt: message.attempt,
        };
        const previous = attempts.get(message.providerAttemptId);
        if (
          previous &&
          (previous.executionId !== token.executionId ||
            previous.generation !== token.generation ||
            previous.attempt !== token.attempt)
        )
          attemptMismatch = message.providerAttemptId;
        attempts.set(message.providerAttemptId, {
          ...token,
          running: previous?.running || message.phase === 'RUNNING',
          terminalReason:
            message.phase === 'TERMINAL' ? message.terminalReason : previous?.terminalReason,
        });
      }
      if (message.type === 'execution_state_changed' && message.phase === 'TERMINAL')
        execution = {
          executionId: message.executionId,
          generation: message.generation,
          terminalReason: message.terminalReason,
        };
    },
    acceptDurableSession(meta) {
      if (meta.sessionId !== sessionId) throw new Error('Durable session identity changed');
      ended = meta.state === 'ENDED' && meta.isActive === false;
    },
    providerComplete() {
      return closeAcknowledged && closePromptSeen && execution;
    },
    complete() {
      return this.providerComplete() && ended;
    },
    evidence() {
      if (!this.complete()) throw new Error('Closeout did not reach its durable terminal state');
      if (execution.terminalReason !== 'completed')
        throw new Error(`Closeout execution ended as ${execution.terminalReason}`);
      if (attemptMismatch) throw new Error(`Provider attempt token changed: ${attemptMismatch}`);
      if (attempts.size !== 1) throw new Error('Closeout did not use exactly one provider attempt');
      const [[providerAttemptId, attempt]] = attempts;
      if (
        !attempt.running ||
        attempt.terminalReason !== 'completed' ||
        attempt.executionId !== execution.executionId ||
        attempt.generation !== execution.generation
      )
        throw new Error('Closeout provider attempt does not match the terminal execution');
      return {
        sessionId,
        executionId: execution.executionId,
        generation: execution.generation,
        providerAttemptId,
        terminalReason: execution.terminalReason,
        providerAttemptCount: attempts.size,
        finalState: 'ENDED',
      };
    },
  };
}

async function checkedJson(response, operation, signal) {
  signal?.throwIfAborted();
  const body = await response.json().catch(() => ({}));
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
  return body;
}

function abortableDelay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('live closeout canary aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForDurableEnd(config, auth, sessionId, signal) {
  for (;;) {
    const meta = await checkedJson(
      await fetch(`${config.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
        headers: auth,
        signal,
      }),
      'durable session state',
      signal,
    );
    if (meta.sessionId !== sessionId) throw new Error('Durable session identity changed');
    if (meta.state === 'ENDED' && meta.isActive === false) return meta;
    await abortableDelay(1_000, signal);
  }
}

export async function runCloseoutLiveCanary(config = liveCanaryConfig()) {
  // This line must precede login, discovery, or provider work so an operator can
  // verify the exact charge identity before the first network request.
  process.stderr.write(
    `[closeout-live-canary] LIVE CHARGE account=${config.accountId} model=${config.model} reasoning=${config.reasoningEffort}\n`,
  );
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error('live closeout canary timed out')),
    config.timeoutMs,
  );

  try {
    const signal = abort.signal;
    const login = await fetch(`${config.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: config.passphrase }),
      signal,
    });
    const { token } = await checkedJson(login, 'login', signal);
    const auth = { authorization: `Bearer ${token}` };
    const stream = await fetch(
      `${config.baseUrl}/api/chat/events?token=${encodeURIComponent(token)}`,
      { signal },
    );
    if (!stream.ok || !stream.body) throw new Error(`SSE connect failed (${stream.status})`);

    const marker = `CLOSEOUT_CANARY_READY_${Date.now()}`;
    const decoder = new TextDecoder();
    let buffer = '';
    let connectionId;
    let sessionId;
    let initialText = '';
    let closeRequested = false;
    let tracker;

    for await (const chunk of stream.body) {
      const parsed = parseSseChunk(buffer, decoder.decode(chunk, { stream: true }));
      buffer = parsed.buffer;
      for (const message of parsed.messages) {
        if (message.type === 'welcome') {
          connectionId = message.connectionId;
          const headers = {
            ...auth,
            'content-type': 'application/json',
            'x-connection-id': connectionId,
          };
          await checkedJson(
            await fetch(`${config.baseUrl}/api/chat/reconnect`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ type: 'reconnect', sessions: [] }),
              signal,
            }),
            'reconnect',
            signal,
          );
          const receipt = await checkedJson(
            await fetch(`${config.baseUrl}/api/chat/send`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                type: 'send',
                sessionId: null,
                clientMsgId: `closeout-canary-${randomUUID()}`,
                accountId: config.accountId,
                model: config.model,
                reasoningEffort: config.reasoningEffort,
                mode: 'auto',
                agentName: 'mitzo-conversational',
                prompt: `Reply with exactly ${marker} and do not use tools.`,
              }),
              signal,
            }),
            'send',
            signal,
          );
          sessionId = receipt.sessionId;
          tracker = createCloseoutTracker(sessionId);
        }

        if (sessionId && message.sessionId === sessionId && !closeRequested) {
          if (message.type === 'block_delta' && message.blockType === 'text')
            initialText += message.delta ?? '';
          if (message.type === 'session_end') {
            if (initialText.trim() !== marker)
              throw new Error('Setup turn did not return the expected unique marker');
            closeRequested = true;
            const headers = {
              ...auth,
              'content-type': 'application/json',
              'x-connection-id': connectionId,
            };
            await checkedJson(
              await fetch(`${config.baseUrl}/api/chat/close`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ type: 'session_close', sessionId }),
                signal,
              }),
              'close',
              signal,
            );
          }
        } else if (closeRequested) {
          tracker?.accept(message);
          if (tracker?.providerComplete()) {
            tracker.acceptDurableSession(await waitForDurableEnd(config, auth, sessionId, signal));
            return tracker.evidence();
          }
        }
      }
    }
    throw new Error('SSE stream ended before closeout completed');
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCloseoutLiveCanary()
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`[closeout-live-canary] ${error.message}\n`);
      process.exitCode = 1;
    });
}
