import { isIP } from 'node:net';
import {
  ianaIpv4SpecialPurposeCidrs,
  ianaIpv6AllocatedGlobalUnicastCidrs,
  ianaIpv6SpecialPurposeCidrs,
} from './iana-address-data.generated.js';

export interface ParsedIpAddress {
  family: 4 | 6;
  value: bigint;
  canonical: string;
}

export interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  prefixLength: number;
}
function addressBits(family: 4 | 6) {
  return family === 4 ? 32 : 128;
}

function ipv6Words(address: string): readonly number[] | undefined {
  const lower = address.toLowerCase();
  const ipv4Suffix = lower.lastIndexOf(':');
  let normalized = lower;
  if (ipv4Suffix !== -1 && lower.slice(ipv4Suffix + 1).includes('.')) {
    const ipv4 = lower.slice(ipv4Suffix + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split('.').map(Number);
    normalized = `${lower.slice(0, ipv4Suffix)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const compressed = normalized.split('::');
  if (compressed.length > 2) return undefined;
  const words = (part: string) =>
    part ? part.split(':').map((word) => Number.parseInt(word, 16)) : [];
  const left = words(compressed[0]!);
  const right = words(compressed[1] ?? '');
  if (
    [...left, ...right].some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff) ||
    (!normalized.includes('::') && left.length !== 8) ||
    (normalized.includes('::') && left.length + right.length > 7)
  )
    return undefined;
  return normalized.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
}

export function parseIpAddress(address: string): ParsedIpAddress | undefined {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return {
      family,
      value: octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n),
      canonical: octets.join('.'),
    };
  }
  if (family === 6) {
    const words = ipv6Words(address);
    if (!words) return undefined;
    return {
      family,
      value: words.reduce((value, word) => (value << 16n) | BigInt(word), 0n),
      canonical: words.map((word) => word.toString(16).padStart(4, '0')).join(':'),
    };
  }
  return undefined;
}

export function parseCidr(cidr: string): ParsedCidr {
  const separator = cidr.lastIndexOf('/');
  const parsed = parseIpAddress(cidr.slice(0, separator));
  const prefixLength = Number(cidr.slice(separator + 1));
  if (
    separator <= 0 ||
    !parsed ||
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > addressBits(parsed.family)
  )
    throw new Error(`Invalid generated IANA CIDR: ${cidr}`);
  const hostBits = BigInt(addressBits(parsed.family) - prefixLength);
  const network = (parsed.value >> hostBits) << hostBits;
  if (network !== parsed.value) throw new Error(`Noncanonical generated IANA CIDR: ${cidr}`);
  return { family: parsed.family, network, prefixLength };
}

function compileCidrs(cidrs: readonly string[]) {
  return Object.freeze(cidrs.map(parseCidr));
}

const ipv4SpecialPurpose = compileCidrs(ianaIpv4SpecialPurposeCidrs);
const ipv6SpecialPurpose = compileCidrs(ianaIpv6SpecialPurposeCidrs);
const ipv6AllocatedGlobalUnicast = compileCidrs(ianaIpv6AllocatedGlobalUnicastCidrs);

export function cidrContains(address: ParsedIpAddress, cidr: ParsedCidr) {
  if (address.family !== cidr.family) return false;
  const hostBits = BigInt(addressBits(address.family) - cidr.prefixLength);
  return address.value >> hostBits === cidr.network >> hostBits;
}

function isIn(address: ParsedIpAddress, table: readonly ParsedCidr[]) {
  return table.some((cidr) => cidrContains(address, cidr));
}

/** Offline, fail-closed IANA classification used before DNS results are pinned. */
export function canonicalPublicDnsAddress(address: string) {
  const parsed = parseIpAddress(address);
  if (!parsed) return undefined;
  if (parsed.family === 4) return isIn(parsed, ipv4SpecialPurpose) ? undefined : parsed.canonical;
  return isIn(parsed, ipv6AllocatedGlobalUnicast) && !isIn(parsed, ipv6SpecialPurpose)
    ? parsed.canonical
    : undefined;
}
