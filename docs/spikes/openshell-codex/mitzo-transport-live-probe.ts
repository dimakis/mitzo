import { CodexAppServerClient } from '../../../server/codex-app-server-client.js';
import { readFileSync } from 'node:fs';

const sandboxName = process.env.MITZO_OPENSHELL_SANDBOX_NAME;
if (!sandboxName) throw new Error('MITZO_OPENSHELL_SANDBOX_NAME is required');
const workdir = process.env.MITZO_OPENSHELL_WORKDIR ?? '/sandbox/workspaces/mgmt';
const model = process.env.MITZO_OPENSHELL_MODEL ?? 'gpt-4.1-mini';
const instructionArtifact = process.env.MITZO_OPENSHELL_INSTRUCTIONS_FILE
  ? readFileSync(process.env.MITZO_OPENSHELL_INSTRUCTIONS_FILE, 'utf8')
  : undefined;
const developerInstructions = instructionArtifact
  ? process.env.MITZO_OPENSHELL_INSTRUCTIONS_FILE?.endsWith('.json')
    ? String(JSON.parse(instructionArtifact).systemPromptAppend)
    : instructionArtifact
  : 'Operate only inside the supplied OpenShell sandbox workspace.';
const prompt =
  process.env.MITZO_OPENSHELL_PROBE_PROMPT ??
  'Use a shell command to create mitzo-transport-marker.txt containing exactly MITZO_OPENSHELL_TRANSPORT=pass, then reply done.';
const normalShape = new Set(
  (process.env.MITZO_OPENSHELL_NORMAL_SHAPE ?? '').split(',').filter(Boolean),
);
let threadId = '';
let complete!: (error?: Error) => void;
const finished = new Promise<void>((resolve, reject) => {
  complete = (error) => (error ? reject(error) : resolve());
});
const client = CodexAppServerClient.launchOpenShell({ sandboxName, workdir }, process.env, {
  onNotification(method, params) {
    if (process.env.MITZO_OPENSHELL_TRACE_ITEMS === '1' && method.startsWith('item/'))
      console.log(JSON.stringify({ method, params }));
    if (method === 'turn/completed' && params.threadId === threadId) {
      if (process.env.MITZO_OPENSHELL_TRACE_ITEMS === '1')
        console.log(JSON.stringify({ method, params }));
      const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
      complete(
        turn?.status === 'completed'
          ? undefined
          : new Error(turn?.error?.message || `OpenShell turn ${turn?.status || 'failed'}`),
      );
    }
  },
  async onRequest() {
    throw new Error('The live probe does not expose host tools');
  },
  onClose() {},
});

try {
  await client.initialize();
  const started = (await client.request('thread/start', {
    model,
    modelProvider: 'openshell',
    allowProviderModelFallback: false,
    cwd: workdir,
    ...(normalShape.has('config') ? { config: { web_search: 'disabled' } } : {}),
    ...(normalShape.has('environments') || normalShape.has('thread-environments')
      ? { environments: [] }
      : {}),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions,
  })) as { thread: { id: string } };
  threadId = started.thread.id;
  await client.request('turn/start', {
    threadId,
    ...(normalShape.has('client-id') ? { clientUserMessageId: crypto.randomUUID() } : {}),
    ...(normalShape.has('turn-model') ? { model } : {}),
    input: [
      {
        type: 'text',
        text: prompt,
      },
    ],
    ...(normalShape.has('environments') || normalShape.has('turn-environments')
      ? { environments: [] }
      : {}),
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      finished,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Mitzo OpenShell transport probe timed out')),
          120_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  console.log('MITZO_OPENSHELL_TRANSPORT_TURN=completed');
} finally {
  client.close();
}
