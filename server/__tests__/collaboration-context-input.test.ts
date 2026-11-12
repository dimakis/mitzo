import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { collaborationArtifactText } from '../collaboration-context-input.js';

afterEach(() => vi.restoreAllMocks());
function artifact(bytes: Buffer, extra: object = {}) {
  return {
    mediaType: 'text/plain; charset=utf-8',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
    ...extra,
  };
}
it('preserves exact UTF-8 including BOM, Unicode, line endings and a named saved JSON version', () => {
  const text = '\uFEFF{"name":"café • 台灣"}\r\n';
  expect(collaborationArtifactText(artifact(Buffer.from(text)))).toBe(text);
  expect(
    collaborationArtifactText(
      artifact(Buffer.from(text), {
        mediaType: 'application/octet-stream',
        filename: 'design.json',
      }),
    ),
  ).toBe(text);
});
it.each([
  [Buffer.from([0xff, 0xfe]), {}],
  [Buffer.from('binary\u0000content'), {}],
  [Buffer.from('%PDF unsupported'), { mediaType: 'application/pdf' }],
  [
    Buffer.from('%PDF unsupported'),
    { mediaType: 'application/octet-stream', filename: 'design.pdf' },
  ],
  [Buffer.from('Missing retained text'), { contentBase64: undefined }],
])(
  'refuses an unsupported or ineligible artifact without a reference-only substitution: %j',
  (bytes, extra) => {
    expect(() => collaborationArtifactText(artifact(bytes as Buffer, extra as object))).toThrow(
      'Choose a supported saved text version',
    );
  },
);
it.each([{ sizeBytes: 1 }, { sha256: 'f'.repeat(64) }, { contentBase64: 'RXhhY3Q' }])(
  'rejects changed custody or noncanonical retained bytes: %j',
  (changed) => {
    expect(() => collaborationArtifactText(artifact(Buffer.from('Exact'), changed))).toThrow(
      'snapshot_changed',
    );
  },
);
it('keeps an unexpected decoder/programming failure observable', () => {
  const error = Error('Unexpected decoder failure');
  vi.spyOn(TextDecoder.prototype, 'decode').mockImplementationOnce(() => {
    throw error;
  });
  expect(() => collaborationArtifactText(artifact(Buffer.from('Exact')))).toThrow(error);
});
