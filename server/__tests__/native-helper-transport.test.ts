import { execFile } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import {
  captureNativeReadAnchor,
  type NativeFileHelperTransport,
} from '../native-file-operation.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(() => {
    throw Error('Direct host fallback forbidden');
  }),
}));
// Decoder/transport fixtures only: these synthetic JSON identities are never
// evidence of source access. Signed actual-SRT coverage lives in the native suite.
const anchor = JSON.stringify({ rootPath: '/fixture', identity: { dev: '1', ino: '2' } });
const valid = `{"content": ${JSON.stringify(anchor)}, "is_error": false}\n`;
it.each([
  'warning\n' + valid,
  valid + '\n' + valid,
  `{"is_error":true,"content":${JSON.stringify(anchor)},"is_error":false}`,
  JSON.stringify({ content: 'private/path/that/must/not/escape', is_error: true }),
  JSON.stringify({ content: anchor, is_error: 'false' }),
  JSON.stringify({ content: anchor, is_error: false, unexpected: 'extra' }),
  'x'.repeat(32769),
])(
  'refuses ambiguous or unsuccessful private helper stdout without a host fallback (%#)',
  async (stdout) => {
    await expect(
      captureNativeReadAnchor(
        { file_path: '/fixture', deniedRoots: [] },
        new AbortController().signal,
        1000,
        async () => ({ stdout, isError: false }),
      ),
    ).rejects.toThrow('Anchored native read unavailable');
    expect(execFile).not.toHaveBeenCalled();
  },
);
it('does not reinterpret a failed shell or rejected transport as successful helper JSON', async () => {
  for (const transport of [
    async () => ({ stdout: valid, isError: true }),
    async () => {
      throw Error('private/scratch/warning');
    },
  ])
    await expect(
      captureNativeReadAnchor(
        { file_path: '/fixture', deniedRoots: [] },
        new AbortController().signal,
        1000,
        transport,
      ),
    ).rejects.toThrow('Anchored native read unavailable');
  expect(execFile).not.toHaveBeenCalled();
});
it('decodes a single bounded helper result using fixed interpreter argv and quoted request data', async () => {
  const run = vi.fn<NativeFileHelperTransport>(async () => ({ stdout: valid, isError: false }));
  expect(
    await captureNativeReadAnchor(
      { file_path: '/fixture', deniedRoots: [] },
      new AbortController().signal,
      1000,
      run,
    ),
  ).toEqual(JSON.parse(anchor));
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0][0]).toMatchObject({ timeoutMs: 1000, maxOutputBytes: 32768 });
  expect(run.mock.calls[0][0].command).toContain(" | /usr/bin/python3 -I -c '");
  expect(execFile).not.toHaveBeenCalled();
});
