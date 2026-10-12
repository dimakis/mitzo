import process from 'node:process';
import { Buffer } from 'node:buffer';
import { join, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  createReadStream,
} from 'node:fs';
import { createZstdDecompress, constants as zlibConstants } from 'node:zlib';
import { setTimeout, clearTimeout } from 'node:timers';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
const fail = (reason) =>
  Error('Fresh staging image ' + reason + '; no native image authority issued');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const metadata = (s) => ({
  dev: s.dev,
  ino: s.ino,
  uid: s.uid,
  mode: s.mode & 0o777,
  nlink: s.nlink,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
/** Read-only original-process proof of a specifically reviewed local stock image.
 * No expanded file is written. This does not approve its provenance, native
 * allocation or start; accepted provisioning facts and live auth supply those. */
export function createFreshStagingImageInspector({
  canonicalRoot,
  image: input,
  nodePin,
  assertOriginalGuard,
  assertNativeAuthenticationCurrent,
}) {
  const image = globalThis.structuredClone(input);
  const root = join(userInfo().homedir, '.local/share/mitzo-staging');
  if (
    canonicalRoot !== root ||
    image?.compression !== 'zstd' ||
    typeof createZstdDecompress !== 'function' ||
    !Number.isSafeInteger(zlibConstants.ZSTD_d_windowLogMax) ||
    !/^[a-f0-9]{64}$/.test(image.sha256 ?? '') ||
    image.path !== join(root, 'symposium/image-sources', image.sha256 + '-arm64.raw.zst') ||
    !Number.isSafeInteger(image.expandedBytes) ||
    image.expandedBytes < 1 ||
    image.expandedBytes > 16 * 1073741824 ||
    !Number.isSafeInteger(image.size) ||
    image.size < 1 ||
    image.size > 1073741824 ||
    typeof assertOriginalGuard !== 'function' ||
    typeof assertNativeAuthenticationCurrent !== 'function' ||
    nodePin?.path !== process.execPath ||
    realpathSync(nodePin.path) !== nodePin.path ||
    sha(readFileSync(nodePin.path)) !== nodePin.sha256
  )
    throw fail('reviewed zstd decoder/input unavailable');
  let parent = dirname(image.path);
  while (parent.startsWith(root)) {
    const s = lstatSync(parent);
    if (
      !s.isDirectory() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o700 ||
      realpathSync(parent) !== parent
    )
      throw fail('private source path changed');
    if (parent === root) break;
    parent = dirname(parent);
  }
  const fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let captured,
    closed = false,
    verified = false,
    pending = false;
  const fence = () => {
    if (closed) throw fail('original inspector closed');
    for (const fn of [assertOriginalGuard, assertNativeAuthenticationCurrent]) {
      const result = fn();
      if (result === false || result instanceof Promise) throw fail('original live authority lost');
    }
    const s = fstatSync(fd),
      path = lstatSync(image.path);
    if (
      !s.isFile() ||
      !path.isFile() ||
      path.isSymbolicLink() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o600 ||
      s.size !== image.size ||
      s.dev !== image.dev ||
      s.ino !== image.ino ||
      image.uid !== s.uid ||
      image.mode !== 0o600 ||
      image.nlink !== 1 ||
      realpathSync(image.path) !== image.path ||
      digest(metadata(s)) !== digest(metadata(path)) ||
      (captured && digest(metadata(s)) !== digest(captured))
    )
      throw fail('immutable source bytes or identity changed');
    captured ??= metadata(s);
  };
  try {
    fence();
  } catch (error) {
    closeSync(fd);
    closed = true;
    throw error;
  }
  return Object.freeze({
    async assertApprovedImage(selected) {
      if (pending || digest(selected) !== digest(image))
        throw fail('exact original image selection required');
      fence();
      const readFd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (digest(metadata(fstatSync(readFd))) !== digest(captured)) {
        closeSync(readFd);
        throw fail('original read identity changed');
      }
      pending = true;
      const compressed = createHash('sha256');
      const input = createReadStream(undefined, {
        fd: readFd,
        autoClose: true,
        start: 0,
        end: image.size - 1,
        highWaterMark: 65536,
      });
      let decoder,
        stream = input,
        compressedBytes = 0,
        expandedBytes = 0,
        first = Buffer.alloc(0),
        last = Buffer.alloc(0),
        lastFence = Date.now();
      input.on('data', (chunk) => {
        compressedBytes += chunk.length;
        compressed.update(chunk);
      });
      if (!verified) {
        // A 128 MiB decoder window plus bounded stream buffers fits the existing
        // 1 GiB launcher budget. Larger-window stock images require new review.
        decoder = createZstdDecompress({
          params: { [zlibConstants.ZSTD_d_windowLogMax]: 27 },
          chunkSize: 65536,
        });
        input.on('error', (error) => decoder.destroy(error));
        input.pipe(decoder);
        stream = decoder;
      }
      const timeout = setTimeout(() => {
        input.destroy(fail('bounded verification expired'));
        decoder?.destroy(fail('bounded verification expired'));
      }, 120000);
      try {
        for await (const chunk of stream) {
          if (decoder) {
            expandedBytes += chunk.length;
            if (expandedBytes > image.expandedBytes || expandedBytes > 16 * 1073741824)
              throw fail('expanded size exceeded reviewed bound');
            if (first.length < 64) first = Buffer.concat([first, chunk]).subarray(0, 64);
            last = Buffer.concat([last, chunk]).subarray(-512);
          }
          if (Date.now() - lastFence >= 1000) {
            fence();
            lastFence = Date.now();
          }
        }
        fence();
        if (compressedBytes !== image.size || compressed.digest('hex') !== image.sha256)
          throw fail('compressed digest changed');
        if (
          decoder &&
          (expandedBytes !== image.expandedBytes ||
            ['514649fb', '4b444d56'].includes(first.subarray(0, 4).toString('hex')) ||
            first.subarray(0, 8).toString() === 'vhdxfile' ||
            last.subarray(0, 8).toString() === 'conectix' ||
            first.toString().includes('Oracle VM VirtualBox Disk Image'))
        )
          throw fail('expanded direct raw image qualification failed');
        verified = true;
        return Object.freeze({
          compressedSha256: image.sha256,
          expandedBytes: image.expandedBytes,
          decoderWindowBytes: 128 * 1024 ** 2,
          nativeAuthority: false,
        });
      } finally {
        clearTimeout(timeout);
        pending = false;
        input.destroy();
        decoder?.destroy();
      }
    },
    close() {
      if (closed) return;
      if (pending) throw fail('verification still owned');
      closed = true;
      closeSync(fd);
    },
  });
}
