import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const snapshotFiles = Object.freeze({
  ipv4: 'ipv4-special-purpose.csv',
  ipv6Special: 'ipv6-special-purpose.csv',
  ipv6Allocated: 'ipv6-global-unicast.csv',
});

function digest(value) {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function rows(csv) {
  const [header, ...body] = csv.trim().split(/\r?\n/);
  const columns = header.split(',');
  return body
    .filter(Boolean)
    .map((line) =>
      Object.fromEntries(line.split(',').map((value, index) => [columns[index], value.trim()])),
    );
}

export async function loadIanaAddressData(root) {
  const dataDirectory = resolve(root, 'server/connections/iana-data');
  const contents = await Promise.all(
    Object.values(snapshotFiles).map((file) => readFile(resolve(dataDirectory, file), 'utf8')),
  );
  const [ipv4, ipv6Special, ipv6Allocated] = contents.map(rows);
  const cidrs = (entries, field) => entries.map((entry) => entry[field]).filter(Boolean);
  return Object.freeze({
    sourceDigests: Object.freeze({
      ipv4: digest(contents[0]),
      ipv6Special: digest(contents[1]),
      ipv6Allocated: digest(contents[2]),
    }),
    ipv4SpecialPurposeCidrs: Object.freeze(cidrs(ipv4, 'Address Block')),
    ipv6SpecialPurposeCidrs: Object.freeze(cidrs(ipv6Special, 'Address Block')),
    ipv6AllocatedGlobalUnicastCidrs: Object.freeze(
      ipv6Allocated.filter((entry) => entry.Status === 'ALLOCATED').map((entry) => entry.Prefix),
    ),
  });
}
