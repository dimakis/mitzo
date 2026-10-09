import { createPrivateKey, createPublicKey } from 'node:crypto';

/** The pinned gateway parses Ed25519 PEM before database/driver startup. Validate
 * the exact bytes frozen for this launch; never include parser errors or keys. */
export function validateGatewaySigningMaterial(bytes: {
  signingKey: Buffer;
  publicKey: Buffer;
  kid: Buffer;
}): void {
  try {
    const signing = createPrivateKey(bytes.signingKey),
      publicKey = createPublicKey(bytes.publicKey);
    if (
      signing.asymmetricKeyType !== 'ed25519' ||
      publicKey.asymmetricKeyType !== 'ed25519' ||
      !createPublicKey(signing)
        .export({ type: 'spki', format: 'der' })
        .equals(publicKey.export({ type: 'spki', format: 'der' })) ||
      !bytes.kid.toString('utf8').trim()
    )
      throw Error();
  } catch {
    throw Error('Gateway signing material must be a matching Ed25519 pair with a nonempty key ID');
  }
}
