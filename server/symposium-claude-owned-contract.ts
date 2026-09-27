import { REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME } from './symposium-owned-runtime-contract.js';

/** Separate provider-specific evidence: existing Codex-only attestations stay valid.
 * This pin alone grants no provider, inference, continuity or admission authority. */
export const REVIEWED_CLAUDE_OWNED_CONTRACT = {
  version: '2.1.156',
  executable: '/usr/local/bin/claude',
  sha256: '7ed95d0a93aeb40e2b98e234b760d9295b7044ef678c62db8d1f5e14bfd57878',
  image: REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image,
  isolation: 'per-seat-per-claim-landlock-v1',
} as const;
