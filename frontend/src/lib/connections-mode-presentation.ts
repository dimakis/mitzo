/** General policy reference; the account inventory does not report a verified runtime. */
export const connectionModes = [
  { id: 'ask', label: 'Ask', summary: 'Read and explore with known read-only tools.' },
  { id: 'agent', label: 'Agent', summary: 'Read and edit, with approval for elevated commands.' },
  { id: 'auto', label: 'Auto', summary: 'Read and edit, with fewer command approvals.' },
] as const;
export type ConnectionMode = (typeof connectionModes)[number]['id'];
export function connectionModePolicy(mode: ConnectionMode) {
  return [
    {
      label: 'Reads',
      text: 'Known read-only tools are automatically allowed by general Mitzo policy.',
    },
    {
      label: 'Edits',
      text:
        mode === 'ask'
          ? 'Only known read-only tools are allowed in Ask; file edits are not allowed by general Mitzo policy.'
          : 'File edits may be automatically allowed, subject to workspace and tool restrictions.',
    },
    {
      label: 'Commands',
      text:
        mode === 'ask'
          ? 'Shell commands are unavailable in Ask, including commands intended only to read.'
          : mode === 'agent'
            ? 'Elevated commands require approval under general Mitzo policy.'
            : 'Elevated commands may be automatically allowed under general Mitzo policy.',
    },
    {
      label: 'Approvals',
      text:
        mode === 'ask'
          ? 'Tools outside the known read-only set are unavailable under general Mitzo policy.'
          : 'Unknown tools still require approval. Required approvals under runtime and service policy still apply. Tool and workspace restrictions may require further decisions.',
    },
    {
      label: 'Network',
      text: 'Network reachability depends on the actual sandbox and attached connections. Mode does not establish network access. Codex provider search requires consent and is disabled in Ask; direct public page reads have separate approvals.',
    },
    {
      label: 'Service permissions',
      text: 'Mode does not expand service permissions. Each service account, allowed action and resource scope still applies.',
    },
  ];
}
export const connectionRuntimeNotes =
  'OpenShell Codex does not support Ask. Other runtimes may differ in available tools and required approvals. Actual runtime and model support has not been checked.';
