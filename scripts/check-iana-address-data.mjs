import { fileURLToPath } from 'node:url';
import { loadIanaAddressData } from './iana-address-data.mjs';
import {
  ianaAddressDataIntegrity,
  ianaIpv4SpecialPurposeCidrs,
  ianaIpv6AllocatedGlobalUnicastCidrs,
  ianaIpv6SpecialPurposeCidrs,
} from '../dist/connections/iana-address-data.generated.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const expected = await loadIanaAddressData(root);
const actual = {
  sourceDigests: ianaAddressDataIntegrity.sourceDigests,
  ipv4SpecialPurposeCidrs: ianaIpv4SpecialPurposeCidrs,
  ipv6SpecialPurposeCidrs: ianaIpv6SpecialPurposeCidrs,
  ipv6AllocatedGlobalUnicastCidrs: ianaIpv6AllocatedGlobalUnicastCidrs,
};
if (JSON.stringify(actual) !== JSON.stringify(expected))
  throw new Error(
    'Generated IANA address tables do not match checked-in snapshots. Review the snapshots and regenerate iana-address-data.generated.ts.',
  );
if (process.argv.includes('--print'))
  process.stdout.write(`${JSON.stringify(expected, null, 2)}\n`);
else process.stdout.write('Generated IANA address data verified.\n');
