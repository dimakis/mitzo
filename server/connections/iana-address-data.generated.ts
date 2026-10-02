/**
 * GENERATED from `server/connections/iana-data/*.csv`.
 *
 * IANA sources retrieved 2026-09-17:
 * - https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
 * - https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
 * - https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv
 *
 * Do not edit tables by hand. See `iana-data/README.md` and
 * `scripts/generate-iana-address-data.mjs` for the reviewed update process.
 */
export const ianaAddressDataProvenance = Object.freeze({
  retrievedOn: '2026-09-17',
  sources: Object.freeze([
    'https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv',
    'https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv',
    'https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv',
  ]),
});
export const ianaAddressDataIntegrity = Object.freeze({
  sourceDigests: Object.freeze({
    ipv4: '45343afe7deccf55cfaf658126ae5933a018e11a36ac5cd80be326e4176f7ab2',
    ipv6Special: '914de0dae87820ff171a91353da88c2d00e569145f5ccbfef560d58272c1a18e',
    ipv6Allocated: '52eefd957023e159eadfe2ca227cb1be27b83b3a4d0871c15c6b689fcf326d9d',
  }),
});

/** Every IANA special-purpose range is denied, even entries marked globally reachable. */
export const ianaIpv4SpecialPurposeCidrs = Object.freeze([
  '0.0.0.0/8',
  '0.0.0.0/32',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.0.0/29',
  '192.0.0.8/32',
  '192.0.0.9/32',
  '192.0.0.10/32',
  '192.0.0.170/32',
  '192.0.0.171/32',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.88.99.2/32',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '240.0.0.0/4',
  '255.255.255.255/32',
]);

/** Every IANA special-purpose range is denied, even entries marked globally reachable. */
export const ianaIpv6SpecialPurposeCidrs = Object.freeze([
  '::1/128',
  '::/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/23',
  '2001::/32',
  '2001:1::1/128',
  '2001:1::2/128',
  '2001:1::3/128',
  '2001:2::/48',
  '2001:3::/32',
  '2001:4:112::/48',
  '2001:10::/28',
  '2001:20::/28',
  '2001:30::/28',
  '2001:db8::/32',
  '2002::/16',
  '2620:4f:8000::/48',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
]);

/** IPv6 is accepted only if it belongs to one of these IANA ALLOCATED ranges. */
export const ianaIpv6AllocatedGlobalUnicastCidrs = Object.freeze([
  '2001::/23',
  '2001:200::/23',
  '2001:400::/23',
  '2001:600::/23',
  '2001:800::/22',
  '2001:c00::/23',
  '2001:e00::/23',
  '2001:1200::/23',
  '2001:1400::/22',
  '2001:1800::/23',
  '2001:1a00::/23',
  '2001:1c00::/22',
  '2001:2000::/19',
  '2001:4000::/23',
  '2001:4200::/23',
  '2001:4400::/23',
  '2001:4600::/23',
  '2001:4800::/23',
  '2001:4a00::/23',
  '2001:4c00::/23',
  '2001:5000::/20',
  '2001:8000::/19',
  '2001:a000::/20',
  '2001:b000::/20',
  '2002::/16',
  '2003::/18',
  '2400::/12',
  '2410::/12',
  '2600::/12',
  '2610::/23',
  '2620::/23',
  '2630::/12',
  '2800::/12',
  '2a00::/12',
  '2a10::/12',
  '2c00::/12',
]);
