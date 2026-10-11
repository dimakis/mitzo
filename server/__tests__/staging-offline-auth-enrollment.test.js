import { Buffer } from 'node:buffer';
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { enrollPreparedOfflineOperatorHelper } from '../../scripts/lib/staging-offline-auth-enrollment.mjs';
const roots = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-auth-enrollment-')));
  roots.push(root);
  const directory = join(root, 'dist/staging-offline-operator-auth');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  mkdirSync(join(root, 'scripts/native'), { recursive: true });
  const source = Buffer.from('reviewed Swift');
  const helper = Buffer.from('compiled helper');
  writeFileSync(join(root, 'scripts/native/staging-operator-auth.swift'), source);
  const path = join(directory, 'helper');
  writeFileSync(path, helper, { mode: 0o500 });
  const stat = lstatSync(path);
  const sourceCommit = 'a'.repeat(40);
  const build = {
    version: 1,
    sourceCommit,
    sourcePath: 'scripts/native/staging-operator-auth.swift',
    sourceSha256: hash(source),
    compiledPath: 'dist/staging-offline-operator-auth/helper',
    compiledSha256: hash(helper),
    swiftVersion: 'Apple Swift version 6.2',
    fileIdentity: Object.fromEntries(
      ['dev', 'ino', 'uid', 'size'].map((name) => [name, stat[name]]),
    ),
  };
  build.fileIdentity.mode = stat.mode & 0o777;
  const bytes = JSON.stringify(build);
  writeFileSync(join(directory, 'build.json'), bytes, { mode: 0o600 });
  const receipt = {
    sourceCommit,
    compiledArtifacts: {
      [build.compiledPath]: hash(helper),
      'dist/staging-offline-operator-auth/build.json': hash(bytes),
    },
  };
  return { root, receipt, build, qualify: () => receipt };
}
describe('prepared helper enrollment', () => {
  it('enrolls only helper bytes present in the qualified frozen artifact inventory', async () => {
    const f = fixture();
    expect(await enrollPreparedOfflineOperatorHelper(f.root, f.qualify)).toEqual({
      helperPath: join(f.root, f.build.compiledPath),
      expectedSha256: f.build.compiledSha256,
    });
  });
  it('refuses a self-asserted helper hash absent from prepared artifacts', async () => {
    const f = fixture();
    delete f.receipt.compiledArtifacts[f.build.compiledPath];
    await expect(enrollPreparedOfflineOperatorHelper(f.root, f.qualify)).rejects.toThrow();
  });
  it('refuses source drift and identity replacement even for identical helper bytes', async () => {
    const f = fixture();
    f.build.fileIdentity.ino++;
    const bytes = JSON.stringify(f.build);
    writeFileSync(join(f.root, 'dist/staging-offline-operator-auth/build.json'), bytes);
    f.receipt.compiledArtifacts['dist/staging-offline-operator-auth/build.json'] = hash(bytes);
    await expect(enrollPreparedOfflineOperatorHelper(f.root, f.qualify)).rejects.toThrow();
  });
  it('requires fresh source qualification after enrollment inspection', async () => {
    const f = fixture();
    let n = 0;
    await expect(
      enrollPreparedOfflineOperatorHelper(f.root, () => {
        if (++n === 2) throw Error('main changed');
        return f.receipt;
      }),
    ).rejects.toThrow('main changed');
  });
});
