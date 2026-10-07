#!/usr/bin/env python3
"""Run with Python 3 on the host; requires the measured image already in Podman.

Creates one disposable --network=none --pull=never --rm container, streams this
file over stdin, and mounts no host paths. No credentials, turn/start, inference,
or runtime resources are used. Reviewers use the host's sealed page tool with
native execution tools disabled; native readOnly command execution is expected
to be unavailable in this image. This is compatibility evidence, not live account
entitlement or integrated review acceptance.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import time

IMAGE = 'sha256:8d228fc4836797a00e09b48166cbeb35e0847aba76b5ef9ff796e0d1c9ae081a'
MANIFEST = 'sha256:19f5e8c3c4eb660a94cd154740ceda3e05abea86b4107a62540a3daadf08dbff'
WORKSPACE = '/sandbox/workspaces/mgmt'
REVIEW_CONFIG = {
    'web_search': '"disabled"',
    'features.use_legacy_landlock': 'true',
    'features.shell_tool': 'false',
    'features.unified_exec': 'false',
    'features.code_mode': 'false',
    'features.code_mode_host': 'false',
}


def host():
    measured = json.loads(subprocess.check_output(
        ['podman', 'image', 'inspect', IMAGE], text=True))[0]
    assert measured['Id'].removeprefix('sha256:') == IMAGE.removeprefix('sha256:')
    assert measured['Digest'] == MANIFEST
    assert measured['Config']['User'] == 'sandbox'
    command = ['podman', 'run', '--rm', '--pull=never', '--network=none', '-i',
               '--entrypoint=/usr/bin/python3', IMAGE, '-I', '-B', '-', '--container']
    result = subprocess.run(command, input=Path(__file__).read_text(), text=True,
                            timeout=120)
    assert result.returncode == 0, f'container exited {result.returncode}'


class Server:
    def __init__(self, seat, mode, config):
        self.seat = '/sandbox/.symposium-seats/' + seat * 64
        os.makedirs(self.seat)
        args = ['/usr/local/bin/symposium-seat-landlock', self.seat, WORKSPACE,
                mode, '/usr/bin/codex', 'app-server', '--stdio']
        for key, value in config.items():
            args += ['-c', key + '=' + value]
        # Do not propagate ambient provider credentials into either app-server.
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            env={'PATH': '/usr/bin:/bin', 'HOME': self.seat,
                 'CODEX_HOME': self.seat + '/.codex'})
        self.next_id = 0

    def rpc(self, method, params):
        assert method in ('initialize', 'model/list', 'command/exec')
        self.next_id += 1
        self.process.stdin.write(json.dumps(
            {'id': self.next_id, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if not select.select([self.process.stdout], [], [], 1)[0]:
                continue
            line = self.process.stdout.readline()
            assert line, 'app-server exited before response'
            response = json.loads(line)
            if response.get('id') == self.next_id:
                assert 'error' not in response, response
                return response['result']
        raise AssertionError('app-server RPC deadline')

    def initialize(self):
        result = self.rpc('initialize', {
            'clientInfo': {'name': 'symposium_no_inference_canary', 'version': '1'},
            'capabilities': {'experimentalApi': True}})
        assert '0.159.1' in result.get('userAgent', ''), result
        self.process.stdin.write(json.dumps({'method': 'initialized', 'params': {}}) + '\n')
        self.process.stdin.flush()
        return result

    def command(self, script, policy):
        result = self.rpc('command/exec', {
            'command': ['/bin/sh', '-lc', script], 'cwd': WORKSPACE,
            'sandboxPolicy': policy, 'timeoutMs': 5000})
        assert isinstance(result.get('exitCode'), int), result
        assert isinstance(result.get('stdout'), str), result
        assert isinstance(result.get('stderr'), str), result
        return result

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def container():
    assert [name for _, name in socket.if_nameindex()] == ['lo'], 'network must be none'
    expected = {
        '/usr/bin/codex': '22c787768933ff4d97e62e2d4613e1671e18b6a2cc999f0666be544acecffa45',
        '/usr/bin/codex-code-mode-host': 'd2f036fd6adc398a1f87a2458c3726558c2eb5660e73dc2b4b4a6b25241c6178',
    }
    for path, digest in expected.items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest, path
    version = subprocess.check_output(['/usr/bin/codex', '--version'], text=True).strip()
    assert version == 'codex-cli 0.159.1', version
    os.makedirs(WORKSPACE, exist_ok=True)
    coder = Server('d', 'write', {'web_search': '"disabled"'})
    reviewer = None
    try:
        coder.initialize()
        external = {'type': 'externalSandbox', 'networkAccess': 'restricted'}
        write = coder.command('printf native-write > native-canary; cat native-canary', external)
        assert write['exitCode'] == 0 and write['stdout'] == 'native-write', write
        escape = coder.command('printf escape > /tmp/native-coder-escape', external)
        assert escape['exitCode'] != 0 and not Path('/tmp/native-coder-escape').exists(), escape
        reviewer = Server('e', 'read', REVIEW_CONFIG)
        reviewer.initialize()
        # Mirror server/model-catalog.ts: field names, normalization, pagination
        # and repeated-cursor rejection. This catalog is bundled/offline only.
        models = {}
        cursor = None
        cursors = set()
        while True:
            params = {'limit': 100, 'includeHidden': True}
            if cursor:
                params['cursor'] = cursor
            catalog = reviewer.rpc('model/list', params)
            assert isinstance(catalog['data'], list), catalog
            for row in catalog['data']:
                assert isinstance(row['model'], str) and row['model'], row
                assert isinstance(row['displayName'], str) and row['displayName'], row
                efforts = row.get('supportedReasoningEfforts', [])
                assert isinstance(efforts, list), row
                assert all(isinstance(e['reasoningEffort'], str) and
                           e['reasoningEffort'] for e in efforts), row
                assert 'defaultReasoningEffort' not in row or isinstance(
                    row['defaultReasoningEffort'], str), row
                models[row['model']] = row
            cursor = catalog.get('nextCursor')
            assert cursor is None or isinstance(cursor, str), catalog
            if not cursor:
                break
            assert cursor not in cursors, 'Model discovery pagination did not advance'
            cursors.add(cursor)
        selected = []
        for model in ('gpt-6-luna', 'gpt-6.1-sol'):
            assert model in models, sorted(models)
            efforts = models[model]['supportedReasoningEfforts']
            assert any(row['reasoningEffort'] == 'low' for row in efforts), efforts
            selected.append({'id': model, 'model': models[model]['model'],
                'displayName': models[model]['displayName'],
                'supportedReasoningEfforts': efforts,
                'normalized': {'id': models[model]['model'],
                    'label': models[model]['displayName'],
                    'reasoningEfforts': [e['reasoningEffort'] for e in efforts],
                    'defaultReasoningEffort': models[model].get('defaultReasoningEffort')}})
        read_only = {'type': 'readOnly'}
        read = reviewer.command('cat native-canary; cat /etc/os-release', read_only)
        unavailable = 'filesystem-restricted execution requires bubblewrap to isolate app-server sockets'
        assert read['exitCode'] == 101 and unavailable in read['stderr'], read
        denials = []
        # Refusal occurs before shell execution. These are unavailable-tool
        # diagnostics, not evidence of usable native readOnly filesystem execution.
        for path in (WORKSPACE + '/native-review-escape',
                     reviewer.seat + '/native-review-escape', '/tmp/native-review-escape'):
            result = reviewer.command('printf escape > ' + path, read_only)
            assert result['exitCode'] == 101 and unavailable in result['stderr'], result
            assert not Path(path).exists(), path
            denials.append({'path': path, 'exitCode': result['exitCode'],
                            'stderr': result['stderr'].strip()})
        print(json.dumps({'passed': True, 'image': IMAGE, 'manifest': MANIFEST,
            'version': version, 'nativeHashes': expected, 'models': selected,
            'coderExternalSandboxWriteExit': write['exitCode'],
            'coderOuterLandlockTmpDenialExit': escape['exitCode'],
            'reviewerNativeReadOnlyExecution': 'unavailable-expected',
            'reviewerRead': read, 'reviewerWriteDenials': denials,
            'reviewerConfig': REVIEW_CONFIG, 'network': 'none', 'hostMounts': 0,
            'credentials': False, 'modelCalls': 0, 'turnStartRequests': 0}, sort_keys=True))
    finally:
        coder.close()
        if reviewer:
            reviewer.close()


if __name__ == '__main__':
    container() if sys.argv[1:] == ['--container'] else host()
