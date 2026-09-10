import WebSocket from 'ws';

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

const url = new URL(baseUrl);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
url.pathname = '/ws/chat';
url.searchParams.set('token', token);

const ws = new WebSocket(url);
const seen = [];
let assignedSession;
let bootContext;
let completed = false;
let sentAt;
let firstToolAt;
let firstToolResultAt;

const timeout = setTimeout(() => {
  ws.terminate();
  throw new Error(`normal chat probe timed out; events=${JSON.stringify(seen.slice(-20))}`);
}, 120_000);

await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2 })));
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    seen.push(message.type);
    if (message.type === 'welcome') {
      sentAt = performance.now();
      ws.send(
        JSON.stringify({
          type: 'send',
          sessionId: null,
          clientMsgId: `openshell-normal-${Date.now()}`,
          accountId: 'openshell-work-api',
          model: 'gpt-5.3-codex',
          mode: 'auto',
          agentName: 'mitzo-conversational',
          prompt:
            'This message explicitly authorizes the local workspace edit. Use the shell now to create normal-chat-marker.txt in the current workspace containing exactly MITZO_NORMAL_CHAT=pass, then reply done. Do not ask for confirmation.',
        }),
      );
    }
    if (message.type === 'session_id') assignedSession = message.sessionId;
    if (message.type === 'boot_context') bootContext = message;
    if (message.type === 'block_start' && message.blockType === 'tool' && !firstToolAt)
      firstToolAt = performance.now();
    if (message.type === 'tool_result' && !firstToolResultAt) firstToolResultAt = performance.now();
    if (message.type === 'error') reject(new Error(`server error: ${message.error}`));
    if (
      assignedSession &&
      ((message.type === 'session_state_changed' && message.state === 'idle') ||
        message.type === 'session_end')
    ) {
      completed = true;
      resolve();
    }
  });
});

clearTimeout(timeout);
ws.close();
if (!completed || !assignedSession) throw new Error('chat did not complete with a session id');
if (!bootContext) throw new Error('boot_context was not delivered');

console.log(`MITZO_NORMAL_CHAT_SESSION=${assignedSession}`);
console.log(`MITZO_NORMAL_CHAT_BOOT_SOURCE=${bootContext.source}`);
console.log(`MITZO_NORMAL_CHAT_BOOT_SOURCES=${bootContext.sourceCount}`);
console.log(`MITZO_NORMAL_CHAT_EVENTS=${seen.join(',')}`);
if (sentAt && firstToolAt)
  console.log(`MITZO_NORMAL_CHAT_FIRST_TOOL_MS=${Math.round(firstToolAt - sentAt)}`);
if (firstToolAt && firstToolResultAt)
  console.log(`MITZO_NORMAL_CHAT_TOOL_RESULT_MS=${Math.round(firstToolResultAt - firstToolAt)}`);
