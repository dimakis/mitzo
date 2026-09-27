/** Opt-in, credential-free real controller/Landlock and Claude version proof.
 * Uses one unique disposable container, no mounts/network/inference. */
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REVIEWED_CLAUDE_OWNED_CONTRACT as contract } from '../symposium-claude-owned-contract.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME as runtime } from '../symposium-owned-runtime-contract.js';
// Test artifact built from source03537c23; never used as production authority.
const candidate = {
  image: 'sha256:df8fd2214ee37f8a306ce98ad722f766f4d5c343ce4e8eda023fdbbc5ab92e47',
  landlock: '2a32470d6854637311cb790553b5c251a46176dced12eb6568f7582852500c34',
  launcher: 'd9cefeef981bc0927b1bd954f358671329ad18488460cc6074a13a0bb634ef5e',
};

it.skipIf(process.env.MITZO_CLAUDE_PHYSICAL_CONTRACT !== '1')(
  'confines two claim homes and executes only the pinned Claude version under the real controller',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-claude-contract-'));
    const run = (args: string[]) =>
      execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', args, {
        encoding: 'utf8',
        env: { HOME: process.env.HOME, PATH: process.env.PATH },
        timeout: 90000,
        maxBuffer: 1024 * 1024,
      }).trim();
    const script = String.raw`
import os,json,subprocess,hashlib,pathlib
P=pathlib.Path
workspace=P('/sandbox/workspaces/mgmt'); workspace.mkdir(parents=True)
homes=P('/sandbox/.symposium-seats'); homes.mkdir(mode=0o700,exist_ok=True)
a='a'*64; b='b'*64
for c in (a,b):
 (homes/c).mkdir(mode=0o700); (homes/c/'sentinel').write_text(c)
(homes/a/'escape').symlink_to(homes/b/'sentinel')
(workspace/'retained').write_text('parent')
controller='/usr/local/bin/symposium-attempt-controller'
receipts=[]
def invoke(claim,access,argv):
 subprocess.run([controller,'run',claim,access,*argv],check=True,timeout=40)
 proof=json.loads(P('/sandbox/.symposium-control',claim+'.done').read_text())
 assert proof=={'claim':claim,'terminal':True,'exit_code':0,'signal':0},proof
 stopped=json.loads(subprocess.check_output([controller,'cancel',claim],timeout=10))
 assert stopped==proof
 receipts.append(proof)
probe=r'''
import os,pathlib,errno
P=pathlib.Path
home=P(os.environ['HOME']); w=P('/sandbox/workspaces/mgmt')
assert home.name=='a'*64
assert (home/'sentinel').read_text()=='a'*64
assert (w/'retained').read_text()=='parent'
def denied(fn):
 try: fn()
 except OSError as e:
  assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),e.errno
 else: raise AssertionError('confinement failed')
denied(lambda: (P('/sandbox/.symposium-seats')/('b'*64)/'sentinel').read_text())
denied(lambda: (home/'escape').read_text())
denied(lambda: P('/sandbox/.symposium-control').iterdir().__next__())
denied(lambda: P('/proc/self/environ').read_bytes())
denied(lambda: P('/tmp/escape').write_text('bad'))
denied(lambda: (w/'new').write_text('bad'))
denied(lambda: (w/'retained').write_text('bad'))
denied(lambda: (w/'retained').unlink())
denied(lambda: (w/'retained').rename(w/'moved'))
(home/'private').write_text('allowed')
'''
invoke(a,'read',['/usr/bin/python3','-I','-B','-c',probe])
writer=r'''
import os,pathlib,errno
P=pathlib.Path
assert P(os.environ['HOME']).name=='b'*64
P('/sandbox/workspaces/mgmt/writer').write_text('allowed')
try: (P('/sandbox/.symposium-seats')/('a'*64)/'private').read_text()
except PermissionError: pass
else: raise AssertionError('other home readable')
'''
invoke(b,'write',['/usr/bin/python3','-I','-B','-c',writer])
assert (workspace/'retained').read_text()=='parent'
assert (workspace/'writer').read_text()=='allowed'
for c in (a,b): assert (homes/c/'sentinel').read_text()==c
invoke('c'*64,'read',['/usr/local/bin/claude','--version'])
os.environ.update({'VERTEX_AI_PROJECT_ID':'project-1','VERTEX_AI_REGION':'global','GOOGLE_VERTEX_AI_TOKEN':'openshell:resolve:env:GOOGLE_VERTEX_AI_TOKEN'})
invoke('d'*64,'read',['/usr/local/bin/symposium-claude-vertex','project-1','global','--version'])
paths=${JSON.stringify(Object.keys(runtime.build.nativeArtifacts))}
paths.extend(['/usr/local/bin/claude','/usr/local/bin/symposium-claude-vertex'])
measured={p:hashlib.sha256(P(p).read_bytes()).hexdigest() for p in paths}
print(json.dumps({'receipts':receipts,'measured':measured,'isolation':True}))
`;
    let id: string | undefined;
    let removed = false;
    const name = `mitzo-claude-contract-${randomUUID()}`;
    const journal = (value: unknown) =>
      writeFileSync(join(root, 'evidence.json'), JSON.stringify(value, null, 2));
    journal({ name, intent: true, modelCalls: 0 });
    try {
      id = run([
        'create',
        '--name',
        name,
        '--pull=never',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=128',
        '--memory=2g',
        '--timeout=75',
        '--user',
        `${runtime.workload.uid}:${runtime.workload.gid}`,
        '--tmpfs',
        '/sandbox:rw,mode=1777',
        '--entrypoint=/usr/bin/python3',
        candidate.image,
        '-I',
        '-B',
        '-c',
        script,
      ]);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      journal({ name, id, modelCalls: 0 });
      const output = run(['start', '--attach', id]);
      const lines = output.split('\n');
      expect(lines[0]).toBe(`${contract.version} (Claude Code)`);
      expect(lines[1]).toBe(`${contract.version} (Claude Code)`);
      const evidence = JSON.parse(lines.at(-1)!);
      expect(evidence.measured).toEqual({
        ...runtime.build.nativeArtifacts,
        [contract.executable]: contract.sha256,
        '/usr/local/bin/symposium-seat-landlock': candidate.landlock,
        '/usr/local/bin/symposium-claude-vertex': candidate.launcher,
      });
      expect(evidence.isolation).toBe(true);
      const [observed] = JSON.parse(run(['inspect', id]));
      expect(observed.Id).toBe(id);
      expect(observed.State).toMatchObject({ Running: false, ExitCode: 0 });
      expect(observed.Mounts).toEqual([]);
      run(['rm', id]);
      removed = true;
      journal({
        name,
        id,
        removed,
        contract,
        candidate,
        evidence,
        modelCalls: 0,
        applicationCredentials: false,
        source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      });
      console.log(`Claude physical evidence: ${root}/evidence.json`);
    } finally {
      if (!removed) console.error(`Retained uncertain Claude contract evidence: ${root}`);
    }
  },
  180000,
);
