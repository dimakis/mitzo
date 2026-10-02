#!/usr/bin/env python3
"""Offline private-identity bootstrap canary. No inference or provider credentials.

Requires the measured image already present. Creates one network-disabled
container, mounts no host paths, and uses synthetic identities/opaque handles.
The loopback URL override exists only in this imported test process; the measured
launcher still pins official URLs. This proves compatibility, not entitlement.
"""
import hashlib
import http.server
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import threading
import time
import tempfile
import uuid
from unittest.mock import patch

IMAGE = 'sha256:3c40c75d441addde40441c89479e6b982735bba16ef7493a552c8450557a632c'
MANIFEST = 'sha256:3e2c2338debf745e6f20dbbd6663e19b0243434e309471fb3b698a02a3dab856'
BOOTSTRAP_SHA = '9bb569cf68df23e8f98c6a2dc2e915f49aa1ddf86a5914539434222907a7cbda'
WORKSPACE = '/sandbox/workspaces/mgmt'
BOOTSTRAP = '/usr/local/bin/symposium-subscription-app-server'
NATIVE_SHA = {
    '/usr/bin/codex': '22c787768933ff4d97e62e2d4613e1671e18b6a2cc999f0666be544acecffa45',
    '/usr/bin/codex-code-mode-host': 'd2f036fd6adc398a1f87a2458c3726558c2eb5660e73dc2b4b4a6b25241c6178',
    '/usr/local/bin/symposium-attempt-controller': 'd9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209',
    '/usr/local/bin/symposium-seat-landlock': 'bf31950c31eafab27d54ddd3662e450769811ea906687616217d743d3134c96d',
}


def environment(claim):
    home = '/sandbox/.symposium-seats/' + claim
    return {'PATH': '/usr/bin:/bin', 'HOME': home, 'CODEX_HOME': home + '/.codex',
            'CODEX_AUTH_ACCESS_TOKEN': 'openshell:resolve:env:s' + 'b' * 64 + '_CODEX_AUTH_ACCESS_TOKEN',
            'CODEX_AUTH_ACCOUNT_ID': 'openshell:resolve:env:v1_CODEX_AUTH_ACCOUNT_ID'}


def frame(claim):
    return (json.dumps({'version': 1, 'claim': claim,
                       'accountId': 'synthetic-account-actual'}) + '\n').encode('ascii')


class Server:
    def __init__(self, argv, env, preface=b''):
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, bufsize=0, env=env)
        self.next_id = 0
        self.buffer = b''
        if preface:
            self.process.stdin.write(preface)
            self.process.stdin.flush()

    def rpc(self, method, params):
        assert method in ('initialize', 'account/read', 'model/list')
        self.next_id += 1
        self.process.stdin.write(json.dumps({'id': self.next_id, 'method': method,
                                            'params': params}).encode() + b'\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if b'\n' not in self.buffer:
                if not select.select([self.process.stdout], [], [], 1)[0]:
                    continue
                chunk = os.read(self.process.stdout.fileno(), 65536)
                assert chunk, 'native metadata process exited'
                self.buffer += chunk
                assert len(self.buffer) < 4 * 1024 * 1024
                continue
            line, self.buffer = self.buffer.split(b'\n', 1)
            response = json.loads(line)
            if response.get('id') == self.next_id:
                assert 'error' not in response, 'native metadata RPC failed'
                return response['result']
        raise AssertionError('native metadata deadline')

    def initialize(self):
        result = self.rpc('initialize', {'clientInfo': {
            'name': 'offline_subscription_identity_canary', 'version': '1'},
            'capabilities': {'experimentalApi': True}})
        assert '0.159.1' in result.get('userAgent', '')
        self.process.stdin.write(b'{"method":"initialized","params":{}}\n')
        self.process.stdin.flush()

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def container():
    assert [name for _, name in socket.if_nameindex()] == ['lo'], 'requires network none'
    for path, digest in {**NATIVE_SHA, BOOTSTRAP: BOOTSTRAP_SHA}.items():
        info = os.stat(path)
        assert info.st_uid == 0 and info.st_mode & 0o777 == 0o755
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
    assert subprocess.check_output(['/usr/bin/codex', '--version'], text=True).strip() == 'codex-cli 0.159.1'
    os.makedirs(WORKSPACE, exist_ok=True)
    claim = 'c' * 64
    native = Server(['/usr/local/bin/symposium-attempt-controller', 'run', claim,
                     'read', BOOTSTRAP], environment(claim), frame(claim))
    try:
        native.initialize()
        assert isinstance(native.rpc('model/list', {'limit': 100, 'includeHidden': True})['data'], list)
    finally:
        native.close()

    loader = importlib.machinery.SourceFileLoader('identity_bootstrap', BOOTSTRAP)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    launcher = importlib.util.module_from_spec(spec)
    loader.exec_module(launcher)
    claim = 'd' * 64
    env = environment(claim)
    os.makedirs(env['HOME'], mode=0o700)
    read_fd, write_fd = os.pipe()
    original_stdin = os.dup(0)
    tail = b'{"id":987,"method":"initialize","params":{}}\n'
    os.write(write_fd, frame(claim) + tail)
    os.close(write_fd)
    try:
        os.dup2(read_fd, 0)
        with patch.object(launcher.os, 'execve') as execute:
            launcher.launch(env)
        assert os.read(0, len(tail)) == tail, 'bootstrap consumed native frame bytes'
        _, argv, child_env = execute.call_args.args
    finally:
        os.dup2(original_stdin, 0)
        os.close(original_stdin)
        os.close(read_fd)
    auth_path = Path(env['CODEX_HOME']) / 'auth.json'
    auth = json.loads(auth_path.read_text())
    assert auth['tokens']['account_id'] == 'synthetic-account-actual'
    assert auth['tokens']['access_token'] == env['CODEX_AUTH_ACCESS_TOKEN']
    assert auth['tokens']['refresh_token'] == ''
    assert auth_path.stat().st_mode & 0o777 == 0o600
    assert Path(env['CODEX_HOME']).stat().st_mode & 0o777 == 0o700
    assert 'CODEX_AUTH_ACCESS_TOKEN' not in child_env
    captured = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.endswith('/accounts/check'):
                captured.append({'accountMatches': self.headers.get('ChatGPT-Account-ID') == 'synthetic-account-actual',
                    'accessOpaque': self.headers.get('Authorization') == 'Bearer ' + env['CODEX_AUTH_ACCESS_TOKEN']})
                body = json.dumps({'accounts': [{'id': 'synthetic-account-actual',
                    'workspace_backend_origin': 'https://chatgpt.com',
                    'account_routing_override': 'NO_CONSTRAINT', 'plan_type': 'pro'}]}).encode()
            else:
                # Native initialization also discovers plugin metadata. No POST
                # handler exists, and all traffic is confined to this loopback fixture.
                body = b'{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    native = Server(argv + ['-c', 'chatgpt_base_url="http://127.0.0.1:' + str(fixture.server_port) + '/backend-api/"'], child_env)
    try:
        native.initialize()
        account = native.rpc('account/read', {'refreshToken': False})
        assert account['account']['type'] == 'chatgpt'
        assert account['workspaceRouting']['chatgptAccountId'] == 'synthetic-account-actual'
        assert captured and all(row['accountMatches'] and row['accessOpaque'] for row in captured)
        models, cursor, seen = {}, None, set()
        while True:
            result = native.rpc('model/list', {'limit': 100, 'includeHidden': True,
                                             **({'cursor': cursor} if cursor else {})})
            for row in result['data']:
                models[row['model']] = row
            cursor = result.get('nextCursor')
            if not cursor:
                break
            assert cursor not in seen
            seen.add(cursor)
        for model in ('gpt-6-luna', 'gpt-6.1-sol'):
            assert any(e['reasoningEffort'] == 'low' for e in models[model]['supportedReasoningEfforts'])
    finally:
        native.close()
        fixture.shutdown()
        fixture.server_close()
    print(json.dumps({'passed': True, 'image': IMAGE, 'manifest': MANIFEST,
        'bootstrapSha256': BOOTSTRAP_SHA, 'nativeBootstrapLandlockInitialize': True,
        'nativeStdinPreserved': True, 'privateAuthPermissions': True,
        'nativeWorkspaceIdentityMatched': True, 'opaqueSyntheticAccessPreserved': True,
        'bundledModels': ['gpt-6-luna', 'gpt-6.1-sol'], 'network': 'none',
        'hostMounts': 0, 'realCredentials': False, 'modelCalls': 0, 'turnStartRequests': 0}))


def host():
    measured = json.loads(subprocess.check_output(['podman', 'image', 'inspect', IMAGE], text=True))[0]
    assert measured['Id'].removeprefix('sha256:') == IMAGE.removeprefix('sha256:')
    assert measured['Digest'] == MANIFEST and measured['Config']['User'] == 'sandbox'
    retained = Path(tempfile.mkdtemp(prefix='symposium-identity-canary-'))
    name = 'symposium-identity-canary-' + uuid.uuid4().hex
    cid = retained / 'container.id'
    intent = retained / 'intent.json'
    state = {'name': name, 'image': IMAGE, 'state': 'run_unknown', 'network': 'none'}
    intent.write_text(json.dumps(state) + '\n')
    os.chmod(intent, 0o600)
    try:
        result = subprocess.run(['podman', 'run', '--name', name, '--cidfile', str(cid),
            '--rm', '--pull=never', '--network=none', '-i', '--entrypoint=/usr/bin/python3',
            IMAGE, '-I', '-B', '-', '--container'], input=Path(__file__).read_text(), text=True,
            capture_output=True, timeout=120)
        state.update(state='completed', exitCode=result.returncode)
        (retained / 'stdout.txt').write_text(result.stdout)
        (retained / 'stderr.txt').write_text(result.stderr)
        if result.returncode != 0:
            raise AssertionError('offline identity canary failed; inspect ' + str(retained))
        print(result.stdout.strip())
    finally:
        # Same retained ID/name only. Never touch another fixture or image.
        target = cid.read_text().strip() if cid.exists() else name
        if cid.exists():
            state['containerId'] = target
        exists = subprocess.run(['podman', 'container', 'exists', target])
        assert exists.returncode in (0, 1), 'cannot reconcile canary container'
        if exists.returncode == 0:
            subprocess.run(['podman', 'rm', '--force', target], check=True,
                           stdout=subprocess.DEVNULL)
        assert subprocess.run(['podman', 'container', 'exists', target]).returncode == 1
        state['containerAbsent'] = True
        intent.write_text(json.dumps(state) + '\n')
        print(json.dumps({'retainedEvidence': str(retained), 'containerAbsent': True}))



if __name__ == '__main__':
    container() if sys.argv[1:] == ['--container'] else host()
