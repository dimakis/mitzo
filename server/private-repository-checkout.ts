import { join } from 'node:path';
/** Fixed synthetic metadata only. Source configuration and attribute conversion
 * never enter this actor's private checkout. Git interprets actual copied OIDs. */
export function privateRepositoryCheckoutConfig(format: 'sha1' | 'sha256') {
  return `[core]\n\trepositoryformatversion = ${format === 'sha256' ? 1 : 0}\n\tfilemode = true\n\tbare = true\n\tsymlinks = true\n${format === 'sha256' ? '[extensions]\n\tobjectformat = sha256\n' : ''}`;
}
export const privateRepositoryCheckoutAttributes =
  '* -text -ident -filter -working-tree-encoding\n';
export interface PrivateRepositoryCheckoutRequest {
  readonly scratch: string;
  readonly baseOid: string;
  readonly objectFormat: 'sha1' | 'sha256';
}
/** Independent worker validation retains exact command equality. No model path,
 * source/admin cwd, generic command or external Git configuration is accepted. */
export function privateRepositoryCheckoutCommand(requestJson: string) {
  if (typeof requestJson !== 'string' || Buffer.byteLength(requestJson) > 8192)
    throw Error('Private checkout unavailable');
  const value = JSON.parse(requestJson);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value) !== requestJson ||
    Object.keys(value).length !== 3 ||
    typeof value.scratch !== 'string' ||
    !value.scratch.startsWith('/') ||
    value.scratch === '/' ||
    /[\0\r\n]/.test(value.scratch) ||
    value.scratch.split('/').some((part: string) => part === '.' || part === '..') ||
    /\/{2}/.test(value.scratch) ||
    value.scratch.endsWith('/') ||
    Buffer.byteLength(value.scratch) > 4096 ||
    !['sha1', 'sha256'].includes(value.objectFormat) ||
    typeof value.baseOid !== 'string' ||
    !new RegExp(`^[a-f0-9]{${value.objectFormat === 'sha256' ? 64 : 40}}$`).test(value.baseOid)
  )
    throw Error('Private checkout unavailable');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const directory = join(value.scratch, 'git-admin'),
    staging = join(value.scratch, 'checkout');
  const git = [
    '/usr/bin/env',
    '-i',
    'PATH=/usr/bin:/bin',
    'HOME=/nonexistent',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_CONFIG_SYSTEM=/dev/null',
    'GIT_NO_LAZY_FETCH=1',
    'GIT_NO_REPLACE_OBJECTS=1',
    'GIT_TERMINAL_PROMPT=0',
    'GIT_ATTR_NOSYSTEM=1',
    '/usr/bin/git',
    '--git-dir',
    directory,
    '--work-tree',
    staging,
    '-c',
    'core.bare=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.attributesFile=/dev/null',
  ];
  // No force flag: foreign files in staging are a refusal, not overwritten.
  return [
    git.concat(['read-tree', value.baseOid]).map(quote).join(' '),
    git.concat(['checkout-index', '--all']).map(quote).join(' '),
  ].join(' && ');
}
