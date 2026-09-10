import { CodexAppServerClient } from '../../../server/codex-app-server-client.js';

const sandboxName = process.env.MITZO_OPENSHELL_SANDBOX_NAME;
if (!sandboxName) throw new Error('MITZO_OPENSHELL_SANDBOX_NAME is required');
const workdir = process.env.MITZO_OPENSHELL_WORKDIR ?? '/sandbox/workspaces/mgmt';
const prompt =
  process.env.MITZO_OPENSHELL_PROBE_PROMPT ??
  'Use a shell command to create mitzo-transport-marker.txt containing exactly MITZO_OPENSHELL_TRANSPORT=pass, then reply done.';
let threadId = '';
let complete!: () => void;
const finished = new Promise<void>((resolve) => (complete = resolve));
const client = CodexAppServerClient.launchOpenShell({ sandboxName, workdir }, process.env, {
  onNotification(method, params) {
    if (method === 'turn/completed' && params.threadId === threadId) complete();
  },
  async onRequest() {
    throw new Error('The live probe does not expose host tools');
  },
  onClose() {},
});

try {
  await client.initialize();
  const started = (await client.request('thread/start', {
    model: 'gpt-4.1-mini',
    modelProvider: 'openshell',
    allowProviderModelFallback: false,
    cwd: workdir,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions: 'Operate only inside the supplied OpenShell sandbox workspace.',
  })) as { thread: { id: string } };
  threadId = started.thread.id;
  await client.request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: prompt,
      },
    ],
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
  });
  await Promise.race([
    finished,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Mitzo OpenShell transport probe timed out')), 120_000),
    ),
  ]);
  console.log('MITZO_OPENSHELL_TRANSPORT_TURN=completed');
} finally {
  client.close();
}
