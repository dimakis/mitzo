import { crc32 } from 'node:zlib';

/** Portable ustar + gzip stored blocks: no filesystem metadata or compressor-version inputs. */
export function canonicalPackageArchive(files) {
  const seen = new Set();
  const entries = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const records = [];
  let size = 1024;
  for (const { name, data } of entries) {
    if (
      !/^package\/[A-Za-z0-9_./-]+$/.test(name) ||
      name.length > 100 ||
      name.split('/').some((part) => part === '.' || part === '..' || !part) ||
      seen.has(name) ||
      !Buffer.isBuffer(data)
    )
      throw new Error('Invalid canonical package entry');
    seen.add(name);
    size += 512 + Math.ceil(data.length / 512) * 512;
    if (size > 16 * 1024 * 1024) throw new Error('Canonical package size limit exceeded');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'ascii');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    records.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  records.push(Buffer.alloc(1024));
  const tar = Buffer.concat(records);
  const gzip = [Buffer.from('1f8b08000000000000ff', 'hex')];
  // RFC 1951 uncompressed blocks have a fixed representation on every platform.
  for (let offset = 0; offset < tar.length; offset += 65535) {
    const block = tar.subarray(offset, offset + 65535);
    const header = Buffer.alloc(5);
    header[0] = offset + block.length === tar.length ? 1 : 0;
    header.writeUInt16LE(block.length, 1);
    header.writeUInt16LE(~block.length & 0xffff, 3);
    gzip.push(header, block);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tar), 0);
  trailer.writeUInt32LE(tar.length, 4);
  gzip.push(trailer);
  return Buffer.concat(gzip);
}
