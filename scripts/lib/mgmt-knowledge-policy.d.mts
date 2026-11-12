import type { PortableSpokePolicy } from './portable-spoke-policy.mjs';
export const mgmtPolicyPath: string;
export const mgmtRequiredPrivateRoots: string[];
export function readMgmtPolicyReceipt(value: unknown): PortableSpokePolicy;
export function mgmtPolicySelectsPath(path: string, policy: PortableSpokePolicy): boolean;
