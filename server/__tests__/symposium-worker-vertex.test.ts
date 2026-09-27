import { it, expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedEvidenceCollector } from '../symposium-owned-evidence-async.js';
import { REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME } from '../symposium-owned-runtime-contract.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
const build = REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build;
const selected = {
  providerInstances: [
    { name: 'personal', id: 'personal-id', type: 'codex', profileName: 'codex' },
    { name: 'work', id: 'work-id', type: 'google-vertex-ai', profileName: 'google-vertex-ai' },
  ],
  allowedRoles: ['reviewer'],
  allowedAccountProviders: ['openai-codex', 'anthropic-vertex'],
  artifactVolume: { driver: 'podman', name: 'artifacts' },
};
const receipt = {
  principal: 'work@example.test',
  accountId: 'work',
  provider: 'work',
  providerId: 'work-id',
  projectId: 'project-1',
  region: 'global' as const,
  model: 'claude-haiku-4-5@20251001' as const,
  workspace: 'workspace',
};
// Actual worker/module/collector/gate. Only public CLI/Podman replies and the
// large pinned binary byte streams are fixtures; no executable, model, or
// credential is contacted. The real retained RPC is not mocked.
const prelude = `
const crypto=require('node:crypto'), cp=require('node:child_process'), fs=require('node:fs');
const fixture=require('node:worker_threads').workerData.fixture;
const hash=crypto.createHash;
crypto.createHash=(algorithm)=>{const parts=[];return {update(value){parts.push(Buffer.from(value));return this;},digest(format){const bytes=Buffer.concat(parts),key=bytes.toString();return key==='fixture-cli'?fixture.build.cliSha256:fixture.build.nativeArtifacts[key]??hash(algorithm).update(bytes).digest(format);}};};
cp.spawnSync=(exe,args)=>{let output;
 if(exe===fixture.cli){
  if(args[0]==='--version')output='openshell '+fixture.build.version;
  else if(args[0]==='gateway')output={gateway:'owned',version:fixture.build.version,status:'healthy',server:'https://localhost:1234',compute_drivers:[{name:'podman',capabilities:{driver_version:fixture.build.version}}]};
  else if(args[0]==='profile')output={id:args[2]};
  else if(args[0]==='provider')output={providers:fixture.providers.map(p=>({...p,workspace:'workspace'})),next_page_token:''};
  else throw Error('unexpected synthetic CLI');
 }else{
  if(args[0]==='image')output=[{Id:fixture.build.image,Digest:'sha256:'+fixture.build.imageDigest}];
  else if(args[0]==='cp'){fs.writeFileSync(args[2],args[1].split(':').slice(1).join(':'));output='';}
  else if(['create','rm'].includes(args[0]))output='';
  else if(args[0]==='volume')output=[{Name:'artifacts',Driver:'local',Options:{},Labels:{'mitzo.symposium.purpose':'artifacts','mitzo.symposium.session':'session','mitzo.symposium.workspace':'workspace','mitzo.symposium.generation':'generation','openshell.ai/sandbox-attachable':'true','openshell.ai/sandbox-attachable-workspace':'workspace'}}];
  else throw Error('unexpected synthetic Podman');
 }
 return {status:0,stdout:typeof output==='string'?output:JSON.stringify(output),stderr:''};
};
require('node:module').syncBuiltinESMExports();
`;
function fixture(overrideSource?: string) {
  const root = mkdtempSync(join(tmpdir(), 'worker-vertex-'));
  const config = {
    cli: join(root, 'cli'),
    gateway: 'owned',
    workspace: 'workspace',
    policy: join(root, 'policy'),
    seed: join(root, 'seed'),
    image: build.image,
    gatewayInsecure: false,
    serviceProviders: [],
    grantableServiceProviders: [],
    cliEnvironment: { HOME: root, XDG_CONFIG_HOME: root, PATH: '/usr/bin:/bin' },
  } as unknown as OpenShellRuntimeConfig;
  writeFileSync(config.cli, 'fixture-cli');
  writeFileSync(config.policy, 'reviewed base policy');
  mkdirSync(config.seed);
  const custody = {
    verifyCustodyAsync: vi.fn(async () => {}),
    verifyOwnedNativeHostAsync: vi.fn(async () => {}),
    verifyGatewayDriverConfigAsync: vi.fn(async () => {}),
    captureClaudeProviderAsync: vi.fn(async () => ({ ...receipt })),
  };
  const spawn = (source: string, options: ConstructorParameters<typeof Worker>[1]) =>
    new Worker(overrideSource ?? prelude + source, {
      ...options,
      workerData: {
        ...options!.workerData,
        fixture: { build, cli: config.cli, providers: selected.providerInstances },
      },
      eval: true,
    });
  const collect = createOwnedEvidenceCollector(
    config,
    'https://localhost:1234',
    { cli: config.cli, podman: '/synthetic-podman', cliEnv: config.cliEnvironment!, podmanEnv: {} },
    custody,
    spawn,
  );
  return { root, custody, collect };
}
it.each([
  'valid',
  'long-account-id',
  'missing',
  'readiness',
  'changed-after-probe',
  'custody-after-probe',
  'extra-field',
  'readiness-after-probe',
])('actual generic Work evidence worker retains owner authority: %s', async (mode) => {
  const f = fixture();
  try {
    if (mode === 'missing')
      delete (f.custody as Partial<typeof f.custody>).captureClaudeProviderAsync;
    if (mode === 'readiness')
      f.custody.captureClaudeProviderAsync.mockRejectedValue(Error('PRIVATE readiness diagnostic'));
    if (mode === 'changed-after-probe')
      f.custody.captureClaudeProviderAsync
        .mockResolvedValueOnce({ ...receipt })
        .mockResolvedValue({ ...receipt, providerId: 'replacement' });
    if (mode === 'custody-after-probe')
      f.custody.captureClaudeProviderAsync.mockImplementation(async () => {
        f.custody.verifyCustodyAsync.mockRejectedValue(Error('PRIVATE custody diagnostic'));
        return { ...receipt };
      });
    if (mode === 'extra-field')
      f.custody.captureClaudeProviderAsync.mockResolvedValue({
        ...receipt,
        secret: 'PRIVATE secret',
      } as never);
    if (mode === 'readiness-after-probe')
      f.custody.captureClaudeProviderAsync
        .mockResolvedValueOnce({ ...receipt })
        .mockRejectedValue(Error('PRIVATE expired readiness'));
    if (mode === 'long-account-id')
      f.custody.captureClaudeProviderAsync.mockResolvedValue({
        ...receipt,
        accountId: 'work_' + 'x'.repeat(256),
      });
    if (mode === 'valid' || mode === 'long-account-id') {
      const candidate = await f.collect(selected);
      expect(candidate.providerInstances).toEqual(selected.providerInstances);
      expect(f.custody.captureClaudeProviderAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(f.custody.captureClaudeProviderAsync).toHaveBeenCalledWith('work-id');
      expect(JSON.stringify(candidate)).not.toContain('work@example.test');
    } else await expect(f.collect(selected)).rejects.toThrow(/Evidence|custody|provider/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it.each([
  { method: 'claude', args: ['foreign-id'] },
  { method: 'claude', args: ['work-id', 'extra'] },
  { method: 'claude', args: ['work-id'], receipt: { credential: 'PRIVATE caller value' } },
])(
  'rejects unselected or malformed worker receipt requests without resolving authority',
  async (request) => {
    const source = `const {workerData,parentPort,receiveMessageOnPort}=require('node:worker_threads');const p=workerData.custodyPort;const s=new Int32Array(workerData.signal);p.postMessage(${JSON.stringify(request)});for(;;){const r=receiveMessageOnPort(p);if(r){if(r.message.ok!==false || 'receipt' in r.message)throw Error('Unexpected authority response');break;}Atomics.wait(s,0,0,20);}p.close();parentPort.close();`;
    const f = fixture(source);
    try {
      await expect(f.collect(selected)).rejects.toThrow('Evidence');
      expect(f.custody.captureClaudeProviderAsync).not.toHaveBeenCalled();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

it('bounds a stalled final owner recapture after the actual worker has exited', async () => {
  const f = fixture();
  f.custody.captureClaudeProviderAsync
    .mockResolvedValueOnce({ ...receipt })
    .mockImplementation(() => new Promise(() => {}));
  try {
    await expect(f.collect(selected)).rejects.toThrow(
      'Evidence retained custody could not be verified',
    );
    expect(f.custody.captureClaudeProviderAsync).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}, 15000);
