export interface ArtifactCapability {
  extensions: readonly string[];
  renderer: string;
  editable: boolean;
}

export interface ClientCapability {
  id: string;
  summary: string;
  agentGuidance: string;
  artifact?: ArtifactCapability;
}

export const MITZO_CLIENT_CAPABILITIES: readonly ClientCapability[] = [
  {
    id: 'html-artifacts',
    summary:
      'Mitzo can preview and edit self-contained HTML artifacts. Previews are sandboxed without network access.',
    agentGuidance:
      'For interactive visual output or UI prototypes, create a self-contained .html file in the workspace and link its file path in your response.',
    artifact: {
      extensions: ['.html', '.htm'],
      renderer: 'html',
      editable: true,
    },
  },
];

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildClientCapabilitiesPrompt(
  capabilities: readonly ClientCapability[] = MITZO_CLIENT_CAPABILITIES,
): string {
  if (capabilities.length === 0) return '';

  const entries = capabilities
    .map(
      (capability) =>
        `  <capability id="${escapeXml(capability.id)}">\n` +
        `    <summary>${escapeXml(capability.summary)}</summary>\n` +
        `    <agent_guidance>${escapeXml(capability.agentGuidance)}</agent_guidance>\n` +
        '  </capability>',
    )
    .join('\n');

  return `\n<mitzo_capabilities>\n${entries}\n</mitzo_capabilities>\n`;
}

export function findArtifactCapabilityByExtension(
  extension: string,
  capabilities: readonly ClientCapability[] = MITZO_CLIENT_CAPABILITIES,
): ClientCapability | undefined {
  const normalized = extension.toLowerCase();
  return capabilities.find((capability) =>
    capability.artifact?.extensions.some((candidate) => candidate === normalized),
  );
}

export function findArtifactCapabilityByPath(
  path: string,
  capabilities: readonly ClientCapability[] = MITZO_CLIENT_CAPABILITIES,
): ClientCapability | undefined {
  const fileName = path.split('/').pop() ?? '';
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot) : '';
  return findArtifactCapabilityByExtension(extension, capabilities);
}
