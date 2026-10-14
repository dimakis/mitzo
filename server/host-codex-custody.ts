import { z } from 'zod';
import { isAbsolute } from 'node:path';
const Path = z.string().min(1).max(4096).refine(isAbsolute);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.strictObject({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
});
const AuthIdentity = Identity.extend({ sha256: Hash }).strict();
export const HostCodexLoginCustodySchema = z.strictObject({
  privateHome: Path,
  sourcePath: Path,
  sourceRoot: Identity,
  sourceAuth: AuthIdentity,
  homeRoot: Identity,
  homeAuth: AuthIdentity,
});
const Integer = z.string().regex(/^\d{1,30}$/);
const Metadata = z.strictObject({
  dev: Integer,
  ino: Integer,
  size: Integer,
  mtimeNs: Integer,
  ctimeNs: Integer,
  uid: Integer,
  mode: Integer,
  nlink: Integer,
  sha256: Hash,
});
const Directory = z.strictObject({ dev: Integer, ino: Integer, uid: Integer, mode: Integer });
export const HostCodexExecutableCustodySchema = z.strictObject({
  path: Path,
  source: Path,
  sha256: Hash,
  sourceIdentity: Metadata,
  ownedIdentity: Metadata,
  sourceDirectory: Directory,
  ownedDirectory: Directory,
});
/** Internal physical custody evidence in the existing native conversation row.
 * Never projected into client inventory or supplied by request JSON.
 */
export const HostCodexCustodySchema = z.strictObject({
  version: z.literal(1),
  authSessionId: z.string().min(1).max(200),
  bootstrapId: Hash,
  agentProfileSha256: Hash.optional(),
  agentContextSha256: Hash.optional(),
  login: HostCodexLoginCustodySchema,
  executable: HostCodexExecutableCustodySchema,
});
export type HostCodexLoginCustody = z.infer<typeof HostCodexLoginCustodySchema>;
export type HostCodexExecutableCustody = z.infer<typeof HostCodexExecutableCustodySchema>;
export type HostCodexCustody = z.infer<typeof HostCodexCustodySchema>;
