import { stripVTControlCharacters } from 'node:util';

// Node's helper misses OSC payloads outside its narrow character set (e.g. +
// in hyperlink URLs). Remove whole OSCs first, including C1 controls and an
// unfinished final payload, so hidden targets never enter filtering or paging.
// eslint-disable-next-line no-control-regex -- terminal control removal is intentional.
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;

export function terminalOutputText(raw: string): string {
  return stripVTControlCharacters(raw.replace(OSC_SEQUENCE, ''));
}
