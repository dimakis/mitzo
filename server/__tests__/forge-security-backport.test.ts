import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { constants, generateKeyPairSync, privateEncrypt, sign } from 'node:crypto';
const require = createRequire(import.meta.url);
const forge = require('node-forge');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
const publicKey = forge.pki.publicKeyFromPem(
  keys.publicKey.export({ type: 'spki', format: 'pem' }),
);
const message = Buffer.from('Mitzo RSA DigestAlgorithm regression');
const hash = forge.md.sha256.create();
hash.update(message.toString());
const digest = hash.digest().getBytes();
function signature(extra: boolean, parameters = true) {
  const a = forge.asn1;
  const children = [
    a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(forge.pki.oids.sha256).getBytes()),
  ];
  if (parameters) children.push(a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''));
  if (extra) children.push(a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, 'garbage'));
  const info = a
    .toDer(
      a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, children),
        a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, digest),
      ]),
    )
    .getBytes();
  const body = Buffer.from(info, 'binary');
  const encoded = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(256 - body.length - 3, 0xff),
    Buffer.from([0]),
    body,
  ]);
  return privateEncrypt(
    { key: keys.privateKey, padding: constants.RSA_NO_PADDING },
    encoded,
  ).toString('binary');
}
it.each([true, false])(
  'rejects extra nested DigestAlgorithm elements (NULL parameters: %s)',
  (parameters) => {
    expect(() => publicKey.verify(digest, signature(true, parameters))).toThrow('DigestInfo');
  },
);
it.each([true, false])(
  'retains valid PKCS#1 v1.5 verification (NULL parameters: %s)',
  (parameters) => {
    expect(publicKey.verify(digest, signature(false, parameters))).toBe(true);
  },
);
it('retains Node-generated signatures and rejects tampered messages', () => {
  const valid = sign('sha256', message, keys.privateKey).toString('binary');
  expect(publicKey.verify(digest, valid)).toBe(true);
  expect(publicKey.verify('x'.repeat(32), valid)).toBe(false);
});
it('loads the reviewed fork for all consumers and reproduces its locked archive', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  expect(require('node-forge/package.json').name).toBe('@mitzo/node-forge-security');
  expect(require('node-forge/package.json').mitzoSecurityBackport.advisory).toBe(
    'GHSA-86w9-cpqp-85rv',
  );
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/build-forge-security-backport.mjs', import.meta.url)),
    '--verify',
  ]);
});
it('does not ship the vulnerable unpatched browser bundles', async () => {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  expect(existsSync(join(dirname(require.resolve('node-forge/package.json')), 'dist'))).toBe(false);
});
