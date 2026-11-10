type Fact = { label: string; value: string };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : [];
const knownFields = (value: unknown, keys: string[]) =>
  value == null ||
  (typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key)));
const pathList = (value: unknown) =>
  value == null ||
  (Array.isArray(value) && value.every((path) => typeof path === 'string' && path.length > 0));

/** Unfamiliar nested scope must retain the open original, even with a known command. */
function knownPermissionScope(value: unknown) {
  const permissions = object(value),
    network = object(permissions.network),
    files = permissions.fileSystem ?? permissions.file_system,
    fileSystem = object(files);
  return (
    knownFields(value, ['network', 'fileSystem', 'file_system']) &&
    knownFields(permissions.network, ['enabled']) &&
    (network.enabled == null || typeof network.enabled === 'boolean') &&
    knownFields(files, ['read', 'write', 'entries']) &&
    pathList(fileSystem.read) &&
    pathList(fileSystem.write) &&
    (fileSystem.entries === undefined ||
      (Array.isArray(fileSystem.entries) &&
        fileSystem.entries.every((raw) => {
          const entry = object(raw),
            path = object(entry.path);
          return (
            knownFields(raw, ['path', 'access']) &&
            ['read', 'write', 'deny'].includes(text(entry.access)) &&
            ((path.type === 'path' &&
              knownFields(entry.path, ['type', 'path']) &&
              !!text(path.path)) ||
              (path.type === 'glob_pattern' &&
                knownFields(entry.path, ['type', 'pattern']) &&
                !!text(path.pattern)))
          );
        })))
  );
}

/** Display only: never modifies an input, response, permission or authority decision. */
export function approvalPresentation(input: string, _toolName?: string) {
  let data: Record<string, unknown> = {};
  try {
    data = object(JSON.parse(input));
  } catch {
    // Unknown/non-JSON inputs retain their complete original display under open details.
  }
  const native =
    typeof data.method === 'string' &&
    [
      'item/commandExecution/requestApproval',
      'item/permissions/requestApproval',
      'item/fileChange/requestApproval',
    ].includes(data.method);
  const params = native ? object(data.params) : data;
  const command = text(params.command) || text(params.cmd);
  const directory = text(params.cwd) || text(params.workdir);
  const rawPermissions =
    params.additionalPermissions ?? params.additional_permissions ?? params.permissions;
  const permissions = object(rawPermissions);
  const network = object(permissions.network);
  const fileSystem = object(permissions.fileSystem ?? permissions.file_system);
  const context = object(params.networkApprovalContext);
  const facts: Fact[] = [];
  if (command) facts.push({ label: 'Command', value: command });
  if (directory) facts.push({ label: 'Directory', value: directory });
  if (network.enabled === true) facts.push({ label: 'Network', value: 'Enabled for this request' });
  if (text(context.host))
    facts.push({ label: 'Connection', value: `${text(context.protocol)} · ${text(context.host)}` });
  for (const [key, label] of [
    ['read', 'Read files'],
    ['write', 'Write files'],
  ] as const) {
    const paths = strings(fileSystem[key]);
    if (paths.length) facts.push({ label, value: paths.join('\n') });
  }
  if (Array.isArray(fileSystem.entries))
    for (const raw of fileSystem.entries) {
      const entry = object(raw),
        path = object(entry.path),
        special = object(path.value);
      const value =
        text(path.path) ||
        text(path.pattern) ||
        [text(special.kind), text(special.subpath), text(special.path)].filter(Boolean).join(' · ');
      if (value) facts.push({ label: `Files · ${text(entry.access) || 'requested'}`, value });
    }
  for (const raw of Array.isArray(params.proposedNetworkPolicyAmendments)
    ? params.proposedNetworkPolicyAmendments
    : []) {
    const amendment = object(raw);
    if (text(amendment.host))
      facts.push({
        label: 'Network policy',
        value: `${text(amendment.action)} · ${text(amendment.host)}`,
      });
  }
  if (Array.isArray(params.proposedExecpolicyAmendment))
    facts.push({
      label: 'Command rule',
      value: strings(params.proposedExecpolicyAmendment).join(' '),
    });
  if (text(params.grantRoot)) facts.push({ label: 'Grant root', value: text(params.grantRoot) });
  if (strings(data.fileChangePaths).length)
    facts.push({ label: 'Changed files', value: strings(data.fileChangePaths).join('\n') });
  const executable = command.match(/^(?:\/[\w.-]+\/)*([\w.-]+)(?:\s|$)/)?.[1];
  const heading =
    native && command
      ? `Run ${executable && executable.length <= 30 ? executable : 'command'}${network.enabled === true ? ' with network access' : ''}`
      : undefined;
  const incompleteCommand = data.method === 'item/commandExecution/requestApproval' && !command;
  return {
    facts,
    heading,
    reason: text(params.reason),
    recognized: facts.length > 0 && knownPermissionScope(rawPermissions) && !incompleteCommand,
  };
}
