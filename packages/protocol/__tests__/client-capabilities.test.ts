import { describe, expect, it } from 'vitest';
import {
  MITZO_CLIENT_CAPABILITIES,
  buildClientCapabilitiesPrompt,
  findArtifactCapabilityByExtension,
  findArtifactCapabilityByPath,
  type ClientCapability,
} from '../src/client-capabilities.js';

describe('client capabilities', () => {
  it('advertises capabilities through a generic structured prompt', () => {
    const capabilities: ClientCapability[] = [
      {
        id: 'example-feature',
        summary: 'Mitzo supports an example feature.',
        agentGuidance: 'Use the example feature when it helps.',
      },
    ];

    expect(buildClientCapabilitiesPrompt(capabilities)).toBe(
      '\n<mitzo_capabilities>\n' +
        '  <capability id="example-feature">\n' +
        '    <summary>Mitzo supports an example feature.</summary>\n' +
        '    <agent_guidance>Use the example feature when it helps.</agent_guidance>\n' +
        '  </capability>\n' +
        '</mitzo_capabilities>\n',
    );
  });

  it('escapes capability values before adding them to the prompt', () => {
    expect(
      buildClientCapabilitiesPrompt([
        {
          id: 'safe&sound',
          summary: '<render> safely',
          agentGuidance: 'Prefer "local" files.',
        },
      ]),
    ).toContain(
      '<capability id="safe&amp;sound">\n' +
        '    <summary>&lt;render&gt; safely</summary>\n' +
        '    <agent_guidance>Prefer &quot;local&quot; files.</agent_guidance>',
    );
  });

  it('returns no prompt block when the client advertises no capabilities', () => {
    expect(buildClientCapabilitiesPrompt([])).toBe('');
  });

  it('uses the shared registry to resolve artifact renderers case-insensitively', () => {
    expect(findArtifactCapabilityByExtension('.HTML')?.artifact?.renderer).toBe('html');
    expect(findArtifactCapabilityByExtension('.htm')?.artifact?.editable).toBe(true);
    expect(findArtifactCapabilityByPath('/tmp/prototype.HTML')?.artifact?.renderer).toBe('html');
    expect(findArtifactCapabilityByExtension('.md')).toBeUndefined();
  });

  it('describes HTML as a client capability without product-specific prohibitions', () => {
    const prompt = buildClientCapabilitiesPrompt(MITZO_CLIENT_CAPABILITIES);

    expect(prompt).toContain('id="html-artifacts"');
    expect(prompt).toContain('self-contained .html');
    expect(prompt).toContain('link its file path');
    expect(prompt).not.toContain('Cursor');
    expect(prompt).not.toContain('Canvas');
  });
});
