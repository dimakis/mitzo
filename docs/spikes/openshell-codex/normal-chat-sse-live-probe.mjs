const baseUrl = process.env.MITZO_PROBE_URL ?? 'http://localhost:4310';
const passphrase = process.env.MITZO_PROBE_PASSPHRASE;
if (!passphrase) throw new Error('MITZO_PROBE_PASSPHRASE is required');

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ passphrase }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { token } = await login.json();
const auth = { authorization: `Bearer ${token}` };

const abort = new AbortController();
const openedAt = performance.now();
const stream = await fetch(`${baseUrl}/api/chat/events?token=${encodeURIComponent(token)}`, {
  signal: abort.signal,
});
if (!stream.ok || !stream.body) throw new Error(`SSE connect failed: ${stream.status}`);

let connectionId;
let sessionId;
let bootContext;
let sentAt;
let firstToolAt;
let firstToolResultAt;
const seen = [];
const decoder = new TextDecoder();
let buffer = '';

const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`SSE normal chat timed out; events=${JSON.stringify(seen.slice(-30))}`)),
    120_000,
  );
  const finish = () => {
    clearTimeout(timer);
    resolve();
  };
  void (async () => {
    try {
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!data) continue;
          const message = JSON.parse(data);
          seen.push(message.type);
          if (message.type === 'welcome') {
            connectionId = message.connectionId;
            const headers = {
              ...auth,
              'content-type': 'application/json',
              'x-connection-id': connectionId,
            };
            await fetch(`${baseUrl}/api/chat/reconnect`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ type: 'reconnect', sessions: [] }),
            });
            sentAt = performance.now();
            const response = await fetch(`${baseUrl}/api/chat/send`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                type: 'send',
                sessionId: null,
                clientMsgId: `openshell-sse-${Date.now()}`,
                accountId: 'openshell-work-api',
                model: 'gpt-5.3-codex',
                mode: 'auto',
                agentName: 'mitzo-conversational',
                prompt:
                  'This message explicitly authorizes the local workspace edit. Use the shell now to create normal-sse-marker.txt in the current workspace containing exactly MITZO_NORMAL_SSE=pass, then reply done. Do not ask for confirmation.',
              }),
            });
            const receipt = await response.json();
            if (!response.ok) throw new Error(`send failed: ${JSON.stringify(receipt)}`);
            sessionId = receipt.sessionId;
          }
          if (message.type === 'boot_context') bootContext = message;
          if (message.type === 'block_start' && message.toolName && !firstToolAt)
            firstToolAt = performance.now();
          if (message.type === 'tool_result' && !firstToolResultAt)
            firstToolResultAt = performance.now();
          if (message.type === 'error') throw new Error(`server error: ${message.error}`);
          if (
            sessionId &&
            message.sessionId === sessionId &&
            (message.type === 'session_end' ||
              (message.type === 'session_state_changed' && message.state === 'idle'))
          )
            return finish();
        }
      }
      throw new Error('SSE stream ended before completion');
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  })();
});

try {
  await completed;
} finally {
  abort.abort();
}
if (!connectionId || !sessionId || !bootContext) throw new Error('missing SSE lifecycle evidence');
console.log(`MITZO_NORMAL_SSE_SESSION=${sessionId}`);
console.log(`MITZO_NORMAL_SSE_CONNECT_MS=${Math.round(sentAt - openedAt)}`);
console.log(`MITZO_NORMAL_SSE_BOOT_SOURCE=${bootContext.source}`);
console.log(`MITZO_NORMAL_SSE_BOOT_SOURCES=${bootContext.sourceCount}`);
if (sentAt && firstToolAt)
  console.log(`MITZO_NORMAL_SSE_FIRST_TOOL_MS=${Math.round(firstToolAt - sentAt)}`);
if (firstToolAt && firstToolResultAt)
  console.log(`MITZO_NORMAL_SSE_TOOL_RESULT_MS=${Math.round(firstToolResultAt - firstToolAt)}`);
console.log(`MITZO_NORMAL_SSE_EVENTS=${seen.join(',')}`);
