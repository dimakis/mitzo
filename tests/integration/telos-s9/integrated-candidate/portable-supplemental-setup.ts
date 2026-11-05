import { vi } from 'vitest';
import { createPortableSupplementalBoundary } from './portable-supplemental-boundary.mjs';

// Only supplemental configurations install this TEST boundary. The actual
// protected runner and all application/CLI/database implementations stay real.
// Native acceptance configurations never import this setup file.
vi.mock('../../../../server/credential-sdk-boundary.js', async (original) => {
  const actual = await original<typeof import('../../../../server/credential-sdk-boundary.js')>();
  return {
    ...actual,
    runtimeFilesystemSdkBoundary: (
      ...args: Parameters<typeof actual.runtimeFilesystemSdkBoundary>
    ) =>
      process.env.S9_SUPPLEMENTAL_PORTABLE_CLI === '1'
        ? createPortableSupplementalBoundary()
        : actual.runtimeFilesystemSdkBoundary(...args),
  };
});
