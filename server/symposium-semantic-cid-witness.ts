/** Private CLI-host create witness. It never creates, starts or adopts a container. */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { canonicalReviewJson } from './symposium-review-records.js';
export type SemanticCidWitnessBinding = {
  jobId: string;
  fenceId: string;
  operationId: string;
  inputJson: string;
  custodyDigest: string;
  codeDigest: string;
  image: string;
};
const LegacyManifest = z.strictObject({
  version: z.literal(1),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().max(4096),
  rootDev: z.number().int().nonnegative().safe(),
  rootIno: z.number().int().nonnegative().safe(),
  parentDev: z.number().int().nonnegative().safe(),
  parentIno: z.number().int().nonnegative().safe(),
  dev: z.number().int().nonnegative().safe(),
  ino: z.number().int().nonnegative().safe(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  mode: z.literal(0o600),
  nlink: z.literal(1),
});
const Reservation = LegacyManifest.omit({
  dev: true,
  ino: true,
  uid: true,
  gid: true,
  mode: true,
  nlink: true,
}).extend({ version: z.literal(2) });
const FileIdentity = LegacyManifest.pick({
  dev: true,
  ino: true,
  uid: true,
  gid: true,
  mode: true,
  nlink: true,
}).extend({ cid: z.string().regex(/^[a-f0-9]{64}$/) });
const NewManifest = Reservation.extend({ file: FileIdentity.optional() });
const Manifest = z.discriminatedUnion('version', [LegacyManifest, NewManifest]);
export type SemanticCidWitnessManifest = z.infer<typeof Manifest>;
export class SemanticCidWitnessOwner {
  private readonly root: string;
  private readonly legacyRoot: string;
  constructor(databasePath: string) {
    const file = lstatSync(databasePath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.())
      throw Error('Private semantic journal owner unavailable');
    this.legacyRoot = join(dirname(realpathSync(databasePath)), '.semantic-cid-witness-v1');
    this.root = join(dirname(realpathSync(databasePath)), '.semantic-cid-witness-v2');
  }
  private digest(binding: SemanticCidWitnessBinding): string {
    if (
      !/^[a-f0-9-]{36}$/.test(binding.jobId) ||
      binding.inputJson.length > 262144 ||
      !/^[a-f0-9]{64}$/.test(binding.custodyDigest) ||
      !/^[a-f0-9]{64}$/.test(binding.codeDigest)
    )
      throw Error('Original semantic witness binding invalid');
    return createHash('sha256').update(canonicalReviewJson(binding)).digest('hex');
  }
  private directory(path: string) {
    const s = lstatSync(path);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o7777) !== 0o700
    )
      throw Error('Private semantic witness directory changed');
    return s;
  }
  private syncDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  prepare(binding: SemanticCidWitnessBinding): SemanticCidWitnessManifest {
    const bindingDigest = this.digest(binding);
    try {
      mkdirSync(this.root, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const rootStat = this.directory(this.root);
    const parent = join(this.root, binding.jobId);
    mkdirSync(parent, { mode: 0o700 }); // Exclusive: never reprepare an original job.
    const parentStat = this.directory(parent);
    const path = join(parent, 'cid');
    // Reserve the private parent and intended path, not a file Podman must create.
    if (lstatSync(path, { throwIfNoEntry: false })) throw Error('Original CID path is not absent');
    const manifest = NewManifest.parse({
      version: 2,
      bindingDigest,
      path,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      parentDev: parentStat.dev,
      parentIno: parentStat.ino,
    });
    const evidence = openSync(
      join(parent, 'manifest.json'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(evidence, canonicalReviewJson(manifest));
      fsyncSync(evidence);
    } finally {
      closeSync(evidence);
    }
    this.syncDirectory(parent);
    this.syncDirectory(this.root);
    this.syncDirectory(dirname(this.root));
    return manifest;
  }
  private assertReservation(m: SemanticCidWitnessManifest, binding: SemanticCidWitnessBinding) {
    const rootPath = m.version === 1 ? this.legacyRoot : this.root;
    if (m.bindingDigest !== this.digest(binding) || m.path !== join(rootPath, binding.jobId, 'cid'))
      throw Error('Original semantic witness binding changed');
    const root = this.directory(rootPath),
      parent = this.directory(dirname(m.path));
    if (
      root.dev !== m.rootDev ||
      root.ino !== m.rootIno ||
      parent.dev !== m.parentDev ||
      parent.ino !== m.parentIno
    )
      throw Error('Original semantic witness directory identity changed');
  }
  /** Only the original create's trusted stdout can confirm a new inode. A file's
   * appearance alone never grants recovery authority after an unknown response. */
  confirm(
    raw: unknown,
    binding: SemanticCidWitnessBinding,
    cid: string,
  ): SemanticCidWitnessManifest {
    const m = NewManifest.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(cid)) throw Error('Original create CID unavailable');
    this.assertReservation(m, binding);
    if (m.file) {
      if (this.read(m, binding) !== cid) throw Error('Original create CID changed');
      return m;
    }
    const fd = openSync(m.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const check = () => {
        const stat = fstatSync(fd),
          named = lstatSync(m.path);
        if (
          !stat.isFile() ||
          !named.isFile() ||
          named.isSymbolicLink() ||
          stat.dev !== named.dev ||
          stat.ino !== named.ino ||
          stat.uid !== process.getuid?.() ||
          stat.nlink !== 1 ||
          named.nlink !== 1 ||
          stat.size !== 64 ||
          (stat.mode & 0o600) !== 0o600 ||
          (stat.mode & 0o7777 & ~0o644) !== 0
        )
          throw Error('Original created witness identity changed');
        return stat;
      };
      const first = check(),
        bytes = Buffer.alloc(65),
        length = readSync(fd, bytes, 0, 65, 0);
      if (length !== 64 || bytes.subarray(0, length).toString('utf8') !== cid)
        throw Error('Original create CID and witness disagree');
      this.assertReservation(m, binding);
      const current = check();
      if (current.dev !== first.dev || current.ino !== first.ino)
        throw Error('Original created witness changed');
      // Podman creates mode 0666 masked by umask; the private parent already
      // excludes other principals. Freeze this confirmed owned file to 0600.
      fchmodSync(fd, 0o600);
      const stat = check();
      fsyncSync(fd);
      const confirmed = NewManifest.parse({
        ...m,
        file: {
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          gid: stat.gid,
          mode: stat.mode & 0o7777,
          nlink: stat.nlink,
          cid,
        },
      });
      const receipt = openSync(
        join(dirname(m.path), 'confirmed.json'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(receipt, canonicalReviewJson(confirmed));
        fsyncSync(receipt);
      } finally {
        closeSync(receipt);
      }
      this.syncDirectory(dirname(m.path));
      return confirmed;
    } finally {
      closeSync(fd);
    }
  }
  read(raw: unknown, binding: SemanticCidWitnessBinding): string {
    const m = Manifest.parse(raw);
    this.assertReservation(m, binding);
    if (m.version === 2 && !m.file)
      throw Error('Original create witness is unconfirmed; retain quarantined operation');
    const identity = m.version === 1 ? m : m.file!;
    const fd = openSync(m.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const check = () => {
        const s = fstatSync(fd),
          l = lstatSync(m.path);
        if (
          !s.isFile() ||
          !l.isFile() ||
          l.isSymbolicLink() ||
          s.dev !== identity.dev ||
          s.ino !== identity.ino ||
          l.dev !== s.dev ||
          l.ino !== s.ino ||
          s.uid !== identity.uid ||
          s.gid !== identity.gid ||
          s.uid !== process.getuid?.() ||
          (s.mode & 0o7777) !== identity.mode ||
          s.nlink !== 1 ||
          l.nlink !== 1 ||
          s.size !== 64
        )
          throw Error('Original semantic witness identity changed');
      };
      check();
      const b = Buffer.alloc(65),
        n = readSync(fd, b, 0, 65, 0);
      const cid = b.subarray(0, n).toString('utf8');
      if (n !== 64 || !/^[a-f0-9]{64}$/.test(cid) || (m.version === 2 && cid !== m.file!.cid))
        throw Error('Original semantic witness content unknown');
      check();
      fsyncSync(fd);
      return cid;
    } finally {
      closeSync(fd);
    }
  }
}

export function semanticCidWitnessDigest(): string {
  return createHash('sha256')
    .update(
      canonicalReviewJson({
        owner: SemanticCidWitnessOwner.toString(),
        schema: z.toJSONSchema(Manifest),
      }),
    )
    .digest('hex');
}
