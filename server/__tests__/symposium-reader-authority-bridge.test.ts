import { expect, it, vi } from 'vitest';
import type { ArtifactReaderAdmissionBindingV1 } from '@mitzo/protocol';
import { createSymposiumReaderAuthorityBridge } from '../symposium-reader-authority-bridge.js';

const binding = { readerAdmissionId: 'reader-1' } as ArtifactReaderAdmissionBindingV1;

it('denies before trusted composition installs exactly one reader authority', () => {
  const bridge = createSymposiumReaderAuthorityBridge();
  expect(() => bridge.authority.assertAdmissionCurrent(binding)).toThrow(/unavailable/);
  const verify = vi.fn(() => true as const);
  bridge.install(verify);
  expect(bridge.authority.assertAdmissionCurrent(binding)).toBe(true);
  expect(verify).toHaveBeenCalledExactlyOnceWith(binding);
  expect(() => bridge.install(() => true)).toThrow(/already installed/);
  expect(bridge.authority.assertAdmissionCurrent(binding)).toBe(true);
});

it('never treats an unset or non-true callback result as authority', () => {
  const bridge = createSymposiumReaderAuthorityBridge();
  expect(() => bridge.install(null as never)).toThrow(/callback/);
  expect(() => bridge.authority.assertAdmissionCurrent(binding)).toThrow(/unavailable/);
  bridge.install((() => false) as never);
  expect(() => bridge.authority.assertAdmissionCurrent(binding)).toThrow(/denied/);
});
