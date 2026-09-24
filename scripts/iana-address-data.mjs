import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const snapshotFiles = Object.freeze({
  ipv4: 'ipv4-special-purpose.csv',
  ipv6Special: 'ipv6-special-purpose.csv',
  ipv6Allocated: 'ipv6-global-unicast.csv',
});

// An independent floor for the reviewed snapshots. Regeneration must not silently
// turn an omitted special-purpose range into a public address. Updating this
// baseline requires reviewing the registry change, not just its generated hash.
const reviewedBaseline = Object.freeze({
  ipv4: {
    minimumRows: 26,
    required: [
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '240.0.0.0/4',
    ].map((cidr) => [cidr, 'False']),
    valueField: 'Globally Reachable',
  },
  ipv6Special: {
    minimumRows: 25,
    required: ['::/128', '::1/128', '::ffff:0:0/96', 'fc00::/7', 'fe80::/10'].map((cidr) => [
      cidr,
      'False',
    ]),
    valueField: 'Globally Reachable',
  },
  ipv6Allocated: {
    minimumRows: 51,
    required: [
      ['2001::/23', 'ALLOCATED'],
      ['3fff::/20', 'RESERVED'],
    ],
    valueField: 'Status',
  },
});

function requireReviewedBaseline(entries, field, baseline, file) {
  const actual = new Map(entries.map((entry) => [entry[field], entry[baseline.valueField]]));
  if (
    entries.length < baseline.minimumRows ||
    baseline.required.some(([cidr, value]) => actual.get(cidr) !== value)
  )
    throw new Error(`${file} is missing reviewed baseline ranges`);
}

function digest(value) {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function validCidr(value, family) {
  const parts = value.split('/');
  if (parts.length !== 2 || isIP(parts[0]) !== family) return false;
  const prefix = Number(parts[1]);
  return (
    /^\d+$/.test(parts[1]) &&
    Number.isInteger(prefix) &&
    prefix >= 0 &&
    prefix <= (family === 4 ? 32 : 128)
  );
}

function rows(csv, file, columns) {
  const lines = csv.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2 || lines.some((line) => line.length === 0))
    throw new Error(`${file} must contain a header and at least one non-empty data row`);
  const actualHeader = lines[0].split(',');
  if (
    actualHeader.length !== columns.length ||
    actualHeader.some((column, index) => column !== columns[index])
  )
    throw new Error(`${file} has an invalid header`);
  return lines.slice(1).map((line, rowIndex) => {
    const values = line.split(',').map((value) => value.trim());
    if (values.length !== columns.length || values.some((value) => value.length === 0))
      throw new Error(`${file} row ${rowIndex + 2} has invalid columns`);
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

function cidrs(entries, field, file, family) {
  const values = entries.map((entry) => entry[field]);
  if (values.some((value) => !validCidr(value, family)))
    throw new Error(`${file} contains an invalid IPv${family} CIDR`);
  if (new Set(values).size !== values.length) throw new Error(`${file} contains duplicate CIDRs`);
  return values;
}

export async function loadIanaAddressData(root) {
  const dataDirectory = resolve(root, 'server/connections/iana-data');
  const contents = await Promise.all(
    Object.values(snapshotFiles).map((file) => readFile(resolve(dataDirectory, file), 'utf8')),
  );
  const ipv4 = rows(contents[0], snapshotFiles.ipv4, ['Address Block', 'Globally Reachable']);
  const ipv6Special = rows(contents[1], snapshotFiles.ipv6Special, [
    'Address Block',
    'Globally Reachable',
  ]);
  const ipv6Allocated = rows(contents[2], snapshotFiles.ipv6Allocated, ['Prefix', 'Status']);
  requireReviewedBaseline(ipv4, 'Address Block', reviewedBaseline.ipv4, snapshotFiles.ipv4);
  requireReviewedBaseline(
    ipv6Special,
    'Address Block',
    reviewedBaseline.ipv6Special,
    snapshotFiles.ipv6Special,
  );
  requireReviewedBaseline(
    ipv6Allocated,
    'Prefix',
    reviewedBaseline.ipv6Allocated,
    snapshotFiles.ipv6Allocated,
  );
  if (
    [...ipv4, ...ipv6Special].some(
      (entry) => !['True', 'False'].includes(entry['Globally Reachable']),
    )
  )
    throw new Error('IANA special-purpose snapshot contains an invalid reachability value');
  if (ipv6Allocated.some((entry) => !['ALLOCATED', 'RESERVED'].includes(entry.Status)))
    throw new Error('IPv6 allocation snapshot contains an invalid status');
  const ipv4Cidrs = cidrs(ipv4, 'Address Block', snapshotFiles.ipv4, 4);
  const ipv6SpecialCidrs = cidrs(ipv6Special, 'Address Block', snapshotFiles.ipv6Special, 6);
  const ipv6AllocatedCidrs = cidrs(ipv6Allocated, 'Prefix', snapshotFiles.ipv6Allocated, 6).filter(
    (_, index) => ipv6Allocated[index].Status === 'ALLOCATED',
  );
  if (!ipv4Cidrs.length || !ipv6SpecialCidrs.length || !ipv6AllocatedCidrs.length)
    throw new Error('IANA policy snapshots must produce non-empty CIDR tables');
  return Object.freeze({
    sourceDigests: Object.freeze({
      ipv4: digest(contents[0]),
      ipv6Special: digest(contents[1]),
      ipv6Allocated: digest(contents[2]),
    }),
    ipv4SpecialPurposeCidrs: Object.freeze(ipv4Cidrs),
    ipv6SpecialPurposeCidrs: Object.freeze(ipv6SpecialCidrs),
    ipv6AllocatedGlobalUnicastCidrs: Object.freeze(ipv6AllocatedCidrs),
  });
}
