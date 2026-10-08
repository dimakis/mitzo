import type {
  ConnectionCredentialField,
  ConnectionTemplate,
  ManagedConnection,
} from '../types/connections';

export const riskCopy = {
  'read-only': 'Read-only access',
  'bounded-write': 'Limited editing access',
  'operator-defined': 'Custom access rules',
} as const;

export const jiraFallbackCredentials: ConnectionCredentialField[] = [
  {
    key: 'token',
    label: 'Replacement API token',
    description: 'One-shot Jira API token for this existing reviewed connection.',
    style: 'basic',
    secret: true,
    required: true,
  },
];
export const time = (value: number | null) =>
  value ? new Date(value).toLocaleString() : 'Not yet verified';
export const connectionErrorMessage = (code: string) =>
  ({
    JIRA_AUTH_REJECTED:
      'Jira rejected the token. Check that it is for redhat.atlassian.net and that the Atlassian account email matches the token.',
    JIRA_PERMISSION_DENIED:
      'Jira denied the identity check. Give the scoped token the Jira read permission needed for /myself and confirm the account has site access.',
    JIRA_HTTP_ERROR:
      'Jira returned an unexpected response. Retry, then check the selected site and token if it continues.',
    JIRA_NETWORK_FAILED: 'Could not reach Jira. Retry the connection.',
    ACCOUNT_ALREADY_ASSIGNED:
      'This work profile is already assigned to another connection. Remove the old connection or choose a different work profile.',
  })[code] ?? code;
export const status = (connection: ManagedConnection) =>
  connection.errorCode
    ? `${connection.status.replaceAll('_', ' ')}: ${connectionErrorMessage(connection.errorCode)}`
    : connection.status.replaceAll('_', ' ');
export const secretValid = (fields: ConnectionCredentialField[], values: Record<string, string>) =>
  fields.every((field) => !field.required || Boolean(values[field.key]));
export const scopeFieldValid = (
  field: ConnectionTemplate['connectionFields'][number],
  value: string,
) => {
  const trimmed = value.trim();
  if (!trimmed) return !field.required;
  if (field.kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  if (field.kind === 'url') {
    try {
      const url = new URL(trimmed);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return true;
};
const customScopeValid = (values: Record<string, string>) => {
  const methods = (values.methods ?? '').split('\n').filter(Boolean);
  const paths = (values.paths ?? '').split('\n').filter(Boolean);
  const protocol = values.protocol;
  const credentialStyle = values.credentialStyle;
  const credentialLocation = values.credentialLocation;
  const credentialName = values.credentialName;
  const credentialsValid =
    (credentialStyle === 'bearer-token' &&
      credentialLocation === 'header' &&
      credentialName === 'authorization') ||
    (credentialStyle === 'api-token' &&
      ((credentialLocation === 'header' && credentialName === 'x-api-key') ||
        (credentialLocation === 'query' && ['api_key', 'access_token'].includes(credentialName))));
  return (
    credentialsValid &&
    (protocol === 'rest'
      ? methods.length > 0 && methods.every((method) => ['GET', 'HEAD', 'OPTIONS'].includes(method))
      : protocol === 'graphql' &&
        methods.length === 1 &&
        methods[0] === 'GRAPHQL_QUERY' &&
        paths.length === 1 &&
        paths[0] === '/graphql')
  );
};
export const scopeValid = (template: ConnectionTemplate, values: Record<string, string>) =>
  template.connectionFields.every((field) => scopeFieldValid(field, values[field.key] ?? '')) &&
  (template.id !== 'custom-rest-readonly' || customScopeValid(values));
export const scopeValues = (template: ConnectionTemplate, values: Record<string, string>) =>
  Object.fromEntries(
    template.connectionFields
      .map((field) => [
        field.key,
        field.kind === 'string-list' || field.kind === 'enum-list'
          ? field.kind === 'enum-list' && singleChoiceCustomFields.has(field.key)
            ? (values[field.key] ?? '').trim()
            : (values[field.key] ?? '')
                .split('\n')
                .map((v) => v.trim())
                .filter(Boolean)
          : (values[field.key] ?? '').trim(),
      ])
      .filter(([, value]) => (Array.isArray(value) ? value.length : value)),
  );
export const templateKey = (template: Pick<ConnectionTemplate, 'id' | 'version'>) =>
  `${template.id}@${template.version}`;
export const singleChoiceCustomFields = new Set([
  'port',
  'protocol',
  'credentialStyle',
  'credentialLocation',
  'credentialName',
  'attachmentMode',
]);
