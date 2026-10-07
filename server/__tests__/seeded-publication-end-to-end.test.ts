import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
const mocks = vi.hoisted(() => ({ approve: vi.fn() }));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.approve,
}));
import { createConnectionsRuntime, setConnectionsRuntime } from '../connections-runtime.js';
import { createGithubPublishingTool } from '../github-publishing-tool.js';
const roots: string[] = [];
afterEach(async () => {
  setConnectionsRuntime(null);
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it.each([
  ['openai-codex', 'openshell', true],
  ['openai', 'host', true],
  ['google-vertex', 'openshell', true],
  ['google-vertex', 'host', true],
  ['openai', 'host', false],
] as const)(
  'publishes an origin-free committed delta through %s/%s with exact approval and verified remote head',
  async (provider, kind, approved) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-seeded-e2e-')));
    roots.push(root);
    const upstream = join(root, 'upstream'),
      seed = join(root, 'mgmt'),
      bin = join(root, 'bin');
    await mkdir(bin);
    const git = (path: string, ...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        [
          '-C',
          path,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
    for (const path of [upstream, seed]) {
      await mkdir(path);
      git(path, 'init', '-q', '-b', 'task');
      await writeFile(join(path, 'note.txt'), 'base\n');
      git(path, 'add', '.');
      git(path, 'commit', '-qm', 'base');
    }
    git(upstream, 'branch', '-M', 'main');
    await writeFile(join(upstream, 'upstream-only.txt'), 'must survive\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-qm', 'upstream-only');
    git(upstream, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
    await writeFile(
      join(root, 'baseline.json'),
      JSON.stringify({ source: upstream, startingCommit: git(upstream, 'rev-parse', 'HEAD') }),
    );
    await writeFile(join(seed, 'note.txt'), 'changed\n');
    git(seed, 'commit', '-qam', 'task change');
    const original = git(seed, 'rev-parse', 'HEAD');
    const header =
      '#!/usr/bin/env node\nconst fs=require("fs"),cp=require("child_process");const root=' +
      JSON.stringify(root) +
      ';const args=process.argv.slice(2);\n';
    await writeFile(
      join(bin, 'git'),
      header +
        String.raw`
const mapped=args.map(x=>x==='https://github.com/example/repo.git'?root+'/upstream':x);
if(mapped.some(x=>/^https?:/.test(x))){console.error('fixture forbids external network');process.exit(1)}
const p=cp.spawnSync('/usr/bin/git',mapped,{env:process.env,encoding:'utf8'});process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');process.exit(p.status??1);
`,
    );
    await writeFile(
      join(bin, 'gh'),
      header +
        String.raw`
const endpoint=args.find(x=>x==='user'||x.startsWith('repos/'));const method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET';
const fields=Object.fromEntries(args.filter((_,i)=>i>0&&['-f','-F'].includes(args[i-1])).map(x=>{const p=x.indexOf('=');return[x.slice(0,p),x.slice(p+1)]}));
const emit=x=>process.stdout.write(JSON.stringify(x));const file=root+'/pull.json';
if(endpoint==='user')emit({login:'operator'});
else if(endpoint==='repos/example/repo')emit({default_branch:'main',full_name:'example/repo'});
else if(endpoint?.startsWith('repos/example/repo/rules/branches/'))emit([]);
else if(endpoint?.startsWith('repos/example/repo/branches/')){
 try{const branch=decodeURIComponent(endpoint.slice('repos/example/repo/branches/'.length));const sha=cp.execFileSync('/usr/bin/git',['-C',root+'/upstream','rev-parse','refs/heads/'+branch],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();emit({protected:false,commit:{sha}})}catch{console.error('404');process.exit(1)}
}else if(endpoint==='repos/example/repo/pulls'&&method==='POST'){
 const pull={html_url:'https://github.com/example/repo/pull/17',number:17,title:fields.title,body:fields.body,draft:fields.draft==='true',state:'open',merged:false,head:{ref:fields.head},base:{ref:fields.base,repo:{full_name:'example/repo'}}};fs.writeFileSync(file,JSON.stringify(pull));emit(pull);
}else if(endpoint==='repos/example/repo/pulls')emit(fs.existsSync(file)?[JSON.parse(fs.readFileSync(file))]:[]);
else if(endpoint==='repos/example/repo/pulls/17')emit(JSON.parse(fs.readFileSync(file)));
else{console.error('unsupported fixture request');process.exit(1)}
`,
    );
    const cli = join(bin, 'openshell');
    await writeFile(
      cli,
      header +
        String.raw`
const start=args.indexOf('/bin/sh');if(start<0)process.exit(1);
const mapped=args.slice(start+1).map(x=>x==='/sandbox/workspaces/mgmt'?root+'/mgmt':x);
const p=cp.spawnSync('/bin/sh',mapped,{encoding:'utf8',env:process.env});process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');process.exit(p.status??1);
`,
    );
    for (const path of ['git', 'gh', 'openshell']) await chmod(join(bin, path), 0o700);
    vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    vi.stubEnv('GH_TOKEN', 'synthetic-fixture-token');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
    const runtime = createConnectionsRuntime({
      directory: join(root, 'state'),
      cli,
      workspace: 'default',
      githubPublishEnabled: true,
      githubSeedBaselinePaths: [join(root, 'baseline.json')],
      eligibleAccountIds: () => ['selected'],
      resolveConversationBinding: () => ({ accountId: 'selected' }),
    });
    setConnectionsRuntime(runtime);
    const created = runtime.store.create({
      ownerId: 'operator',
      templateId: 'github-readonly',
      templateVersion: 1,
      label: 'Fixture',
      endpoint: 'https://api.github.com',
      gatewayProviderName: 'github-fixture',
      desiredAccountIds: ['selected'],
      publicConfig: { allowedRepositories: ['example/repo'], allowedBaseBranches: ['main'] },
    });
    const connection = runtime.store.transition(
      created.id,
      created.revision,
      {
        status: 'active',
        gatewayProviderId: 'fixture-provider',
        identity: 'operator',
        verifiedAt: Date.now(),
      },
      { operation: 'provision', outcome: 'success', actor: 'operator' },
    );
    runtime.capabilities.setGrant({
      connectionId: connection.id,
      connectionRevision: connection.revision,
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      accountIds: ['selected'],
      status: 'active',
    });
    runtime.capabilityStore.approveGithubRepository({
      connectionId: connection.id,
      connectionRevision: connection.revision,
      accountId: 'selected',
      repository: 'example/repo',
    });
    const session = {
      sessionId: 'conversation',
      cwd: kind === 'host' ? seed : '/sandbox/workspaces/mgmt',
      mode: 'auto',
      accountBinding: { accountId: 'selected', provider, model: 'fixture', profileRevision: '1' },
      activeSkillPolicy: null,
    } as unknown as ManagedSession;
    const registry = {
      findBySessionId: () => ({ session, clientId: 'owner' }),
      get: () => session,
    } as unknown as SessionRegistry;
    mocks.approve.mockReset();
    mocks.approve.mockImplementation(async (_name, input) => ({
      behavior: approved ? 'allow' : 'deny',
      updatedInput: input,
    }));
    const tool = createGithubPublishingTool('conversation', registry, () =>
      kind === 'host'
        ? { runtime: 'host', workspace: seed, gitStorageRoots: [] }
        : { runtime: 'openshell', workspace: '/sandbox/workspaces/mgmt', sandboxName: 'retained' },
    );
    try {
      const source =
        kind === 'host'
          ? { runtime: 'host' as const, workspace: seed, gitStorageRoots: [] }
          : {
              runtime: 'openshell' as const,
              workspace: '/sandbox/workspaces/mgmt',
              sandboxName: 'retained',
            };
      await expect(
        runtime.resolveGithubPublishingRepository!(
          source,
          session.cwd!,
          'main',
          AbortSignal.timeout(10000),
        ),
      ).resolves.toBe('example/repo');
      const result = await tool(
        {
          repositoryPath: session.cwd!,
          baseBranch: 'main',
          title: 'Approved task delta',
          body: 'Only committed changes',
          draft: true,
        },
        AbortSignal.timeout(20000),
        { turnId: 'turn', callId: 'call' },
      );
      const detail = JSON.parse(result.content);
      if (!approved) {
        expect(detail).toMatchObject({ status: 'denied' });
        expect(git(upstream, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
          'refs/heads/main',
        );
        expect(await readFile(join(root, 'pull.json')).catch(() => null)).toBeNull();
        expect(git(seed, 'rev-parse', 'HEAD')).toBe(original);
        return;
      }
      expect(detail, result.content).toMatchObject({
        status: 'succeeded',
        result: {
          pullRequestUrl: 'https://github.com/example/repo/pull/17',
          originalSourceOid: original,
        },
      });
      expect(mocks.approve).toHaveBeenCalledTimes(1);
      const card = mocks.approve.mock.calls[0]![1];
      expect(card.input).toMatchObject({
        repository: 'example/repo',
        originalSourceOid: original,
        changedFiles: '["note.txt"]',
      });
      expect(mocks.approve.mock.calls[0]![2]).toMatchObject({ forcePrompt: true });
      const branch = detail.result.sourceBranch;
      expect(git(upstream, 'rev-parse', branch)).toBe(detail.result.sourceOid);
      expect(git(upstream, 'show', branch + ':note.txt')).toBe('changed');
      expect(git(upstream, 'show', branch + ':upstream-only.txt')).toBe('must survive');
      expect(git(seed, 'rev-parse', 'HEAD')).toBe(original);
      expect(git(seed, 'status', '--short')).toBe('');
      expect(git(seed, 'remote')).toBe('');
    } finally {
      tool.close();
      runtime.store.close();
      runtime.capabilityStore.close();
    }
  },
  30000,
);
