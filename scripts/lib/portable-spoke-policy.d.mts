export interface PortableSpokePolicy {
  version: 1;
  portableRoots: string[];
  markdownRoots: string[];
  privateRoots: string[];
}
export function parsePortableSpokePolicy(
  value: unknown,
  requiredPrivateRoots?: string[],
): PortableSpokePolicy;
export function portableSpokePaths(policy: PortableSpokePolicy): string[];
export function portableSpokePathSelected(policy: PortableSpokePolicy, path: string): boolean;

export function parsePortableSpokePolicyText(
  content: string,
  requiredPrivateRoots?: string[],
): PortableSpokePolicy;

export function portableSpokePathPermitted(policy: PortableSpokePolicy, path: string): boolean;
