import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createVertexSeatPolicy, writeVertexSeatPolicy } from './vertex-seat-policy.mjs';

const input = {
  project: 'work-vertex-project',
  region: 'us-east4',
  model: 'claude-haiku-4-5@20251001',
  claudeBinary: '/usr/local/bin/claude',
  providerName: 'work-vertex-seat',
};

test('binds exactly one regional host, project, region, model, and Claude executable', () => {
  const rule = createVertexSeatPolicy(input).network_policies.claude_vertex_haiku;
  assert.deepEqual(rule.binaries, [{ path: input.claudeBinary }]);
  assert.deepEqual(rule.endpoints.map((e) => e.path), [
    '/v1/projects/work-vertex-project/locations/us-east4/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
    '/v1/projects/work-vertex-project/locations/us-east4/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict',
  ]);
  for (const endpoint of rule.endpoints) {
    assert.equal(endpoint.host, 'us-east4-aiplatform.googleapis.com');
    assert.equal(endpoint.credential_binding.provider, input.providerName);
    assert.equal(endpoint.rules.length, 1);
    assert.deepEqual(endpoint.rules[0].allow, { method: 'POST', path: endpoint.path });
    assert.equal(Object.hasOwn(endpoint, 'access'), false);
    assert.equal(endpoint.enforcement, 'enforce');
    assert.equal(Object.hasOwn(endpoint, 'tls'), false);
    assert.equal(endpoint.allow_uninspected_credentials, false);
  }
});

test('rejects wildcard or alternate routes and models before policy construction', () => {
  for (const [key, value] of [
    ['project', 'other/project'], ['region', '*'],
    ['model', 'claude-sonnet-4-5@20250929'], ['model', 'claude-haiku-*'],
    ['claudeBinary', '/usr/local/bin/*'], ['claudeBinary', 'claude'],
    ['providerName', 'work-vertex-seat/**'],
  ]) {
    assert.throws(() => createVertexSeatPolicy({ ...input, [key]: value }));
  }
});

test('writes an exclusive, parseable sandbox policy without replacing an existing one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vertex-seat-policy-'));
  const path = join(dir, 'seat.json');
  await writeVertexSeatPolicy(path, input, { include_workdir: false, read_only: ['/usr'] });
  const policy = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(policy.network_policies.claude_vertex_haiku.endpoints.length, 2);
  assert.deepEqual(policy.filesystem_policy, { include_workdir: false, read_only: ['/usr'] });
  await assert.rejects(writeVertexSeatPolicy(path, input));
});
