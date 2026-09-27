import { expect, it } from 'vitest';
import { custodianAppEnvironment } from '../symposium-custodian-launch.js';
it('passes explicit app configuration without provider secrets or a second owned-host bootstrap', () => {
  const env = custodianAppEnvironment({
    PATH: '/usr/bin',
    HOME: '/test/home',
    AUTH_PASSPHRASE: 'test-app-passphrase',
    REPO_PATH: '/test/repo',
    PORT: '4000',
    MITZO_DISABLE_REPO_MAINTENANCE: '1',
    MITZO_REPO_PATH_CEILING: '/test/repo',
    MITZO_WORKTREE_CLEANUP_POLICY: 'report',
    XDG_CONFIG_HOME: '/test/config',
    XDG_STATE_HOME: '/test/state',
    XDG_CACHE_HOME: '/test/cache',
    MITZO_ACCOUNT_PROFILES_FILE: '/test/empty-accounts.json',
    MITZO_CODEX_ENABLED: '1',
    MITZO_SYMPOSIUM_OWNED_HOST_CONFIG: '/private/host.json',
    OPENAI_API_KEY: 'must-not-copy',
    GOOGLE_APPLICATION_CREDENTIALS: '/private/adc.json',
    SYMPOSIUM_NATIVE_ATTEMPT_DIR: '/private/claims',
    NODE_OPTIONS: '--import unsafe',
    MITZO_CODEX_PRIVATE_DIR: '/private/native-ledger',
  });
  expect(env).toMatchObject({
    AUTH_PASSPHRASE: 'test-app-passphrase',
    PORT: '4000',
    MITZO_DISABLE_REPO_MAINTENANCE: '1',
    MITZO_REPO_PATH_CEILING: '/test/repo',
    MITZO_WORKTREE_CLEANUP_POLICY: 'report',
    XDG_CONFIG_HOME: '/test/config',
    XDG_STATE_HOME: '/test/state',
    XDG_CACHE_HOME: '/test/cache',
    MITZO_ACCOUNT_PROFILES_FILE: '/test/empty-accounts.json',
    MITZO_CODEX_ENABLED: '1',
    MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER: '1',
    DOTENV_CONFIG_PATH: '/dev/null',
    MITZO_CODEX_PRIVATE_DIR: '/private/native-ledger',
  });
  for (const key of [
    'MITZO_SYMPOSIUM_OWNED_HOST_CONFIG',
    'OPENAI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SYMPOSIUM_NATIVE_ATTEMPT_DIR',
    'NODE_OPTIONS',
  ])
    expect(env[key]).toBeUndefined();
});

it('rotates app authentication for every child while retaining the configured login passphrase', () => {
  const source = { AUTH_SECRET: 'old-parent-signing-secret', AUTH_PASSPHRASE: 'test-passphrase' };
  const first = custodianAppEnvironment(source);
  const second = custodianAppEnvironment(source);
  expect(first.AUTH_SECRET === source.AUTH_SECRET).toBe(false);
  expect(second.AUTH_SECRET === first.AUTH_SECRET).toBe(false);
  expect(second.AUTH_PASSPHRASE).toBe(source.AUTH_PASSPHRASE);
});

it('rejects a prior child JWT on generic replay, SSE and WebSocket authentication after replacement', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (env: NodeJS.ProcessEnv, code: string, input = '') => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code],
      {
        cwd: process.cwd(),
        env: { ...env, NODE_ENV: 'test' },
        input,
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    if (result.status !== 0) throw new Error('Offline child authentication probe failed');
    return result.stdout.trim();
  };
  const source = { PATH: process.env.PATH, AUTH_PASSPHRASE: 'synthetic-custodian-test-passphrase' };
  // Only the auth module is loaded: no app, provider, fixture or inference process.
  const first = custodianAppEnvironment(source);
  const second = custodianAppEnvironment(source);
  delete first.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER;
  delete second.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER;
  const token = run(
    first,
    `const a=await import('./server/auth.ts');
    const t=await a.login(process.env.AUTH_PASSPHRASE); const s=await a.authenticateToken(t);
    a.revokeAuthSession(s); if(await a.authenticateToken(t)) throw Error(); process.stdout.write(t);`,
  );
  const result = run(
    second,
    `let old=''; for await(const c of process.stdin)old+=c;
    const a=await import('./server/auth.ts'); const fresh=await a.login(process.env.AUTH_PASSPHRASE);
    async function http(token,path,sse=false) { let next=false,status=200;
      const req={path,method:'GET',headers:sse?{}:{authorization:'Bearer '+token},cookies:{},query:sse?{token}:{}};
      const res={locals:{},status(n){status=n;return this},json(){}};
      await a.authMiddleware(req,res,()=>{next=true}); return {next,status}; }
    process.stdout.write(JSON.stringify({
      oldReplay:await http(old,'/sessions/synthetic-symposium/messages'),
      oldSse:await http(old,'/chat/events',true), oldWs:!!await a.authenticateWs(undefined,old),
      freshReplay:await http(fresh,'/sessions/synthetic-symposium/messages'),
      freshSse:await http(fresh,'/chat/events',true), freshWs:!!await a.authenticateWs(undefined,fresh)}));`,
    token,
  );
  expect(JSON.parse(result)).toEqual({
    oldReplay: { next: false, status: 401 },
    oldSse: { next: false, status: 401 },
    oldWs: false,
    freshReplay: { next: true, status: 200 },
    freshSse: { next: true, status: 200 },
    freshWs: true,
  });
});
