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
  const runningAttempts = new Set();
  const terminalAttempts = new Map();
  let closePromptSeen = false;
  let closeAcknowledged = false;
  let execution;
  let ended = false;

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
        if (message.phase === 'RUNNING') runningAttempts.add(message.providerAttemptId);
        if (message.phase === 'TERMINAL')
          terminalAttempts.set(message.providerAttemptId, message.terminalReason);
      }
      if (message.type === 'execution_state_changed' && message.phase === 'TERMINAL')
        execution = {
          executionId: message.executionId,
          generation: message.generation,
          terminalReason: message.terminalReason,
        };
      if (message.type === 'session_state_changed' && message.internalState === 'ENDED')
        ended = true;
    },
    complete() {
      return closeAcknowledged && closePromptSeen && execution && ended;
    },
    evidence() {
      if (!this.complete()) throw new Error('Closeout did not reach its durable terminal state');
      if (execution.terminalReason !== 'completed')
        throw new Error(`Closeout execution ended as ${execution.terminalReason}`);
      if (runningAttempts.size !== 1 || terminalAttempts.size !== 1)
        throw new Error('Closeout did not use exactly one provider attempt');
      const [providerAttemptId] = runningAttempts;
      if (
        !terminalAttempts.has(providerAttemptId) ||
        terminalAttempts.get(providerAttemptId) !== 'completed'
      )
        throw new Error('Closeout provider attempt did not complete successfully');
      return {
        sessionId,
        executionId: execution.executionId,
        generation: execution.generation,
        providerAttemptId,
        terminalReason: execution.terminalReason,
        providerAttemptCount: runningAttempts.size,
        finalState: 'ENDED',
      };
    },
  };
}

async function checkedJson(response, operation) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
  return body;
}

export async function runCloseoutLiveCanary(config = liveCanaryConfig()) {
  // This line must precede login, discovery, or provider work so an operator can
  // verify the exact charge identity before the first network request.
  process.stderr.write(
    `[closeout-live-canary] LIVE CHARGE account=${config.accountId} model=${config.model} reasoning=${config.reasoningEffort}\n`,
  );

  const login = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: config.passphrase }),
  });
  const { token } = await checkedJson(login, 'login');
  const auth = { authorization: `Bearer ${token}` };
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error('live closeout canary timed out')),
    config.timeoutMs,
  );
  const stream = await fetch(
    `${config.baseUrl}/api/chat/events?token=${encodeURIComponent(token)}`,
    { signal: abort.signal },
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

  try {
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
            }),
            'reconnect',
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
            }),
            'send',
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
              }),
              'close',
            );
          }
        } else if (closeRequested) {
          tracker?.accept(message);
          if (tracker?.complete()) return tracker.evidence();
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
