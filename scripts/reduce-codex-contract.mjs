import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

export function reduceCodexContract(version, schemas) {
  const methods = (schema) => schema.oneOf.map((entry) => entry.properties.method.enum[0]);
  const requests = methods(schemas.requests);
  if (
    requests.some((method) => /search/i.test(method) && /approval|requestUserInput/i.test(method))
  )
    throw new Error('New native search approval contract requires policy review');
  const notifications = methods(schemas.notifications);
  if (!['item/started', 'item/completed'].every((method) => notifications.includes(method)))
    throw new Error('Missing item lifecycle notifications');
  if (
    !schemas.notifications.definitions.ThreadItem.oneOf.some((item) =>
      item.properties.type.enum.includes('webSearch'),
    )
  )
    throw new Error('Missing native webSearch item');
  const lifecycle = Object.fromEntries(
    Object.entries(schemas.lifecycle).map(([method, schema]) => [
      `thread/${method}`,
      Object.hasOwn(schema.properties, 'config'),
    ]),
  );
  if (!Object.values(lifecycle).every(Boolean))
    throw new Error('Missing thread configuration boundary');
  return {
    codexCliVersion: version,
    generatedWith: 'codex app-server generate-json-schema --experimental',
    serverRequestMethods: requests,
    permissionsApprovalFields: Object.keys(schemas.permissions.properties),
    threadLifecycleConfig: lifecycle,
    webSearchObservation: {
      itemType: 'webSearch',
      notifications: ['item/started', 'item/completed'],
      preExecutionApprovalMethod: null,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, output] = process.argv.slice(2);
  if (!directory || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !output)
    throw new Error('Usage: reduce-codex-contract SCHEMA_DIRECTORY VERSION OUTPUT');
  const read = (name) => {
    const path = join(directory, `${name}.json`);
    return JSON.parse(
      readFileSync(existsSync(path) ? path : join(directory, 'v2', `${name}.json`), 'utf8'),
    );
  };
  const result = reduceCodexContract(version, {
    requests: read('ServerRequest'),
    notifications: read('ServerNotification'),
    permissions: read('PermissionsRequestApprovalParams'),
    lifecycle: Object.fromEntries(
      ['Start', 'Resume', 'Fork'].map((name) => [name.toLowerCase(), read(`Thread${name}Params`)]),
    ),
  });
  writeFileSync(output, await format(JSON.stringify(result), { parser: 'json' }));
}
