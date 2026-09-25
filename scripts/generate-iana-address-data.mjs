import { loadIanaAddressData } from './iana-address-data.mjs';
import { fileURLToPath } from 'node:url';

function table(name, values, comment) {
  return `/** ${comment} */\nexport const ${name} = Object.freeze([\n${values
    .map((value) => `  ${literal(value)},`)
    .join('\n')}\n]);`;
}

function literal(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function renderIanaAddressData(data, retrievedOn) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrievedOn))
    throw new Error('Pass --retrieved-on YYYY-MM-DD when regenerating IANA policy data.');
  return `/**
 * GENERATED from \`server/connections/iana-data/*.csv\`.
 *
 * IANA sources retrieved ${retrievedOn}:
 * - https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
 * - https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
 * - https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv
 *
 * Do not edit tables by hand. See \`iana-data/README.md\` and
 * \`scripts/generate-iana-address-data.mjs\` for the reviewed update process.
 */
export const ianaAddressDataProvenance = Object.freeze({
  retrievedOn: ${literal(retrievedOn)},
  sources: Object.freeze([
    'https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv',
    'https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv',
    'https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv',
  ]),
});
export const ianaAddressDataIntegrity = Object.freeze({
  sourceDigests: Object.freeze({
    ipv4: ${literal(data.sourceDigests.ipv4)},
    ipv6Special: ${literal(data.sourceDigests.ipv6Special)},
    ipv6Allocated: ${literal(data.sourceDigests.ipv6Allocated)},
  }),
});

${table(
  'ianaIpv4SpecialPurposeCidrs',
  data.ipv4SpecialPurposeCidrs,
  'Every IANA special-purpose range is denied, even entries marked globally reachable.',
)}

${table(
  'ianaIpv6SpecialPurposeCidrs',
  data.ipv6SpecialPurposeCidrs,
  'Every IANA special-purpose range is denied, even entries marked globally reachable.',
)}

${table(
  'ianaIpv6AllocatedGlobalUnicastCidrs',
  data.ipv6AllocatedGlobalUnicastCidrs,
  'IPv6 is accepted only if it belongs to one of these IANA ALLOCATED ranges.',
)}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const retrievedIndex = process.argv.indexOf('--retrieved-on');
  const retrievedOn = retrievedIndex === -1 ? undefined : process.argv[retrievedIndex + 1];
  if (!retrievedOn)
    throw new Error('Pass --retrieved-on YYYY-MM-DD when regenerating IANA policy data.');
  process.stdout.write(
    renderIanaAddressData(await loadIanaAddressData(process.cwd()), retrievedOn),
  );
}
