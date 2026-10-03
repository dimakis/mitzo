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
          ? 'Commands are allowed only when classified as known read-only tools.'
          : mode === 'agent'
            ? 'Elevated commands require approval under general Mitzo policy.'
            : 'Elevated commands may be automatically allowed under general Mitzo policy.',
    },
    {
      label: 'Approvals',
      text:
        mode === 'ask'
          ? 'Tools outside the known read-only set are unavailable under general Mitzo policy.'
          : 'Unknown tools still require approval. Tool and workspace restrictions may require further decisions.',
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
  'Runtime and model compatibility are not reported by this inventory. If a chat uses Claude SDK, Ask uses SDK plan mode and Agent/Auto use SDK default mode with Mitzo policy. Host Codex tools enforce Mitzo policy; native read-only settings alone do not prevent edits. OpenShell Codex does not support Ask at startup or when switching modes; it accepts Agent and Auto.';
