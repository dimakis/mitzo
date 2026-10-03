import { expect, it } from 'vitest';
import { createICloudUploadProbe } from '../backup/icloud-upload-probe.js';

it('requires explicit native upload confirmation', async () => {
  expect(
    await createICloudUploadProbe(
      '/trusted/helper',
      async () => '{"status":"uploaded"}',
    )('/private/opaque-object'),
  ).toBe('uploaded');
  expect(
    await createICloudUploadProbe(
      '/trusted/helper',
      async () => '{"status":"pending"}',
    )('/private/opaque-object'),
  ).toBe('pending');
});
it('treats malformed, missing and failed native evidence as unknown', async () => {
  for (const output of [
    '{}',
    '{"status":true}',
    '{"status":"uploaded","privatePath":"secret"}',
    'private failure',
  ]) {
    expect(
      await createICloudUploadProbe(
        '/trusted/helper',
        async () => output,
      )('/private/opaque-object'),
    ).toBe('unknown');
  }
  expect(
    await createICloudUploadProbe('/trusted/helper', async () => {
      throw new Error('private error');
    })('/private/opaque-object'),
  ).toBe('unknown');
});
it('rejects untrusted relative executables and invalid paths', async () => {
  expect(() => createICloudUploadProbe('helper')).toThrow();
  expect(
    await createICloudUploadProbe(
      '/trusted/helper',
      async () => '{"status":"uploaded"}',
    )('relative-object'),
  ).toBe('unknown');
});
