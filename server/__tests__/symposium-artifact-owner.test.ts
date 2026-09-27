import { expect, it } from 'vitest';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
it('binds only the reviewed immutable workload image to its resolved sandbox identity', () => {
  const image = 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161';
  expect(symposiumArtifactOwner(image)).toEqual({ image, uid: 998, gid: 998 });
  for (const unreviewed of ['latest', 'sha256:' + 'a'.repeat(64), 'sandbox', '__proto__'])
    expect(() => symposiumArtifactOwner(unreviewed)).toThrow('not reviewed');
});
