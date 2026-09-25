export interface IanaAddressData {
  sourceDigests: Readonly<{
    ipv4: string;
    ipv6Special: string;
    ipv6Allocated: string;
  }>;
  ipv4SpecialPurposeCidrs: readonly string[];
  ipv6SpecialPurposeCidrs: readonly string[];
  ipv6AllocatedGlobalUnicastCidrs: readonly string[];
}

export function loadIanaAddressData(root: string): Promise<IanaAddressData>;
