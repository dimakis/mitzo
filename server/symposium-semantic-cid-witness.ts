/** Private CLI-host create witness. It never creates, starts or adopts a container. */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
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
const Manifest = z.strictObject({
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
export type SemanticCidWitnessManifest = z.infer<typeof Manifest>;
export class SemanticCidWitnessOwner {
  private readonly root: string;
  constructor(databasePath: string) {
    const file = lstatSync(databasePath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.())
      throw Error('Private semantic journal owner unavailable');
    this.root = join(dirname(realpathSync(databasePath)), '.semantic-cid-witness-v1');
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
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const s = fstatSync(fd);
      fsyncSync(fd);
      const manifest = Manifest.parse({
        version: 1,
        bindingDigest,
        path,
        rootDev: rootStat.dev,
        rootIno: rootStat.ino,
        parentDev: parentStat.dev,
        parentIno: parentStat.ino,
        dev: s.dev,
        ino: s.ino,
        uid: s.uid,
        gid: s.gid,
        mode: s.mode & 0o7777,
        nlink: s.nlink,
      });
      // Retain preparation evidence even if the subsequent journal CAS fails.
      // This local copy is never a recovery authority without the DB manifest.
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
    } finally {
      closeSync(fd);
    }
  }
  read(raw: unknown, binding: SemanticCidWitnessBinding): string {
    const m = Manifest.parse(raw);
    if (
      m.bindingDigest !== this.digest(binding) ||
      m.path !== join(this.root, binding.jobId, 'cid')
    )
      throw Error('Original semantic witness binding changed');
    const root = this.directory(this.root),
      parent = this.directory(dirname(m.path));
    if (
      root.dev !== m.rootDev ||
      root.ino !== m.rootIno ||
      parent.dev !== m.parentDev ||
      parent.ino !== m.parentIno
    )
      throw Error('Original semantic witness directory identity changed');
    const fd = openSync(m.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const check = () => {
        const s = fstatSync(fd),
          l = lstatSync(m.path);
        if (
          !s.isFile() ||
          !l.isFile() ||
          l.isSymbolicLink() ||
          s.dev !== m.dev ||
          s.ino !== m.ino ||
          l.dev !== s.dev ||
          l.ino !== s.ino ||
          s.uid !== m.uid ||
          s.gid !== m.gid ||
          s.uid !== process.getuid?.() ||
          (s.mode & 0o7777) !== m.mode ||
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
      if (n !== 64 || !/^[a-f0-9]{64}$/.test(cid))
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
