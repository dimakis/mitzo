// Generate the sandbox policy for one Claude Vertex seat. The workspace must
// import vertex-seat-endpointless.yaml as its google-vertex-ai profile first.
import { writeFile } from 'node:fs/promises';
const identifier = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const regionPattern = /^[a-z]+-[a-z]+[0-9]+$/;
const modelPattern = /^claude-haiku-4-5@20251001$/;

function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

export function createVertexSeatPolicy({ project, region, model, claudeBinary, providerName }) {
  requireMatch(project, identifier, 'Vertex project');
  requireMatch(region, regionPattern, 'Vertex region');
  requireMatch(model, modelPattern, 'Haiku model');
  requireMatch(providerName, identifier, 'provider name');
  if (typeof claudeBinary !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*claude$/.test(claudeBinary)) {
    throw new TypeError('Claude binary must be an exact absolute path ending in /claude');
  }

  const base = `/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model}`;
  const endpoint = (operation) => {
    const path = `${base}:${operation}`;
    return {
      host: `${region}-aiplatform.googleapis.com`,
      path,
      port: 443,
      protocol: 'rest',
      enforcement: 'enforce',
      allow_uninspected_credentials: false,
      request_body_credential_rewrite: false,
      credential_binding: { provider: providerName },
      rules: [{ allow: { method: 'POST', path } }],
    };
  };

  return {
    version: 1,
    network_policies: {
      claude_vertex_haiku: {
        name: 'claude-vertex-haiku',
        endpoints: [endpoint('rawPredict'), endpoint('streamRawPredict')],
        binaries: [{ path: claudeBinary }],
      },
    },
  };
}

// JSON is valid YAML for OpenShell's policy parser. The caller owns the
// sandbox-specific path and can add its separately reviewed filesystem policy.
export async function writeVertexSeatPolicy(path, options, filesystemPolicy) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('Policy destination must be an absolute path');
  }
  const policy = createVertexSeatPolicy(options);
  if (filesystemPolicy !== undefined) policy.filesystem_policy = filesystemPolicy;
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
