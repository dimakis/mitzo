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


test('global selection uses the documented global host without changing the selected model', () => {
  const policy = createVertexSeatPolicy({ ...input, region: 'global' });
  const endpoints = policy.network_policies.claude_vertex_haiku.endpoints;
  assert.equal(endpoints.length, 2);
  for (const [index, endpoint] of endpoints.entries()) {
    const operation = index === 0 ? 'rawPredict' : 'streamRawPredict';
    const path = `/v1/projects/${input.project}/locations/global/publishers/anthropic/models/${input.model}:${operation}`;
    assert.equal(endpoint.host, 'aiplatform.googleapis.com');
    assert.equal(endpoint.path, path);
    assert.deepEqual(endpoint.rules, [{ allow: { method: 'POST', path } }]);
    assert.deepEqual(endpoint.credential_binding, { provider: input.providerName });
    assert.equal(endpoint.allow_uninspected_credentials, false);
  }
});

test('rejects aliases, malformed global locations and trailing control characters', () => {
  for (const [key, value] of [
    ['region', 'GLOBAL'], ['region', 'global/other'], ['region', 'global-aiplatform'],
    ['region', 'global\n'], ['model', 'claude-haiku-4-5'],
    ['model', 'claude-haiku-4-5@20251001\n'], ['project', 'work-vertex-project\n'],
    ['providerName', 'work-vertex-seat\n'], ['claudeBinary', '/usr/local/bin/claude\n'],
  ]) assert.throws(() => createVertexSeatPolicy({ ...input, [key]: value }));
});
