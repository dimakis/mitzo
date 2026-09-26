import importlib.machinery
import importlib.util
import json
import os
import stat
import sys
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader('launcher', '/usr/local/bin/symposium-subscription-app-server')
spec = importlib.util.spec_from_loader(loader.name, loader)
launcher = importlib.util.module_from_spec(spec)
loader.exec_module(launcher)
for ancestor in ['/', '/sandbox', '/sandbox/.symposium-seats']:
    try:
        fd = os.open(ancestor, os.O_RDONLY | os.O_DIRECTORY)
    except PermissionError:
        continue
    os.close(fd)
    raise AssertionError('ancestor READ_DIR was not denied')
env = dict(os.environ)
env.update(CODEX_AUTH_ACCESS_TOKEN='openshell:resolve:env:s' + 'b'*64 + '_CODEX_AUTH_ACCESS_TOKEN',
           CODEX_AUTH_ACCOUNT_ID='openshell:resolve:env:v1_CODEX_AUTH_ACCOUNT_ID',
           OPENAI_API_KEY='fake-key-that-must-be-stripped')
def fake_exec(binary, argv, child_env):
    assert binary == '/usr/bin/codex'
    assert argv[1:3] == ['app-server', '--stdio']
    assert 'OPENAI_API_KEY' not in child_env
    assert child_env['CODEX_HOME'] == env['CODEX_HOME']
launcher.os.execve = fake_exec
launcher.launch(env)
launcher.launch(env)
auth_path = env['CODEX_HOME'] + '/auth.json'
assert stat.S_IMODE(os.stat(env['HOME']).st_mode) == 0o700
assert stat.S_IMODE(os.stat(env['CODEX_HOME']).st_mode) == 0o700
assert stat.S_IMODE(os.stat(auth_path).st_mode) == 0o600
with open(auth_path) as stream:
    auth = json.load(stream)
assert auth['auth_mode'] == 'chatgptAuthTokens'
assert auth['tokens']['access_token'] == env['CODEX_AUTH_ACCESS_TOKEN']
print('PASS: real Linux Landlock denied ancestor READ_DIR; private bootstrap and restart succeeded; mocked exec only; no network/model calls')
