import { expect, it } from 'vitest';
import {
  REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
} from '../symposium-owned-runtime-contract.js';
import { REVIEWED_CLAUDE_OWNED_CONTRACT } from '../symposium-claude-owned-contract.js';

it('pins Claude separately without changing the existing Codex-only artifact contract', () => {
  expect(REVIEWED_CLAUDE_OWNED_CONTRACT).toMatchObject({
    version: '2.1.156',
    executable: '/usr/local/bin/claude',
    sha256: '7ed95d0a93aeb40e2b98e234b760d9295b7044ef678c62db8d1f5e14bfd57878',
    image: REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image,
    isolation: 'per-seat-per-claim-landlock-v1',
  });
  expect(Object.keys(REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.nativeArtifacts)).toHaveLength(4);
  expect(REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.nativeArtifacts).not.toHaveProperty(
    '/usr/local/bin/claude',
  );
});
