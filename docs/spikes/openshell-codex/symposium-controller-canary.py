#!/usr/bin/python3
"""No-model controller contract checks; run only in a disposable Linux sandbox."""
import json
import os
import pathlib
import secrets
import subprocess
import time

controller = '/usr/local/bin/symposium-attempt-controller'
workspace = pathlib.Path('/sandbox/workspaces/mgmt')
workspace.mkdir(parents=True, exist_ok=True)


def proof(claim):
    result = subprocess.run([controller, 'cancel', claim], capture_output=True, text=True, check=True)
    value = json.loads(result.stdout)
    assert value['claim'] == claim and value['terminal'] is True
    assert type(value['exit_code']) is int and type(value['signal']) is int
    return value


claim = secrets.token_hex(32)
result = subprocess.run([controller, 'run', claim, 'read', '/bin/pwd'], capture_output=True, text=True, check=True)
assert result.stdout.strip() == str(workspace)
assert proof(claim)['exit_code'] == 0
assert proof(claim) == proof(claim)
assert subprocess.run([controller, 'run', claim, 'read', '/bin/true']).returncode != 0
assert subprocess.run([controller, 'cancel', secrets.token_hex(32)], capture_output=True).returncode != 0

# The primary exits leaving a detached child. The subreaper must adopt, kill,
# and reap it before recording terminal=true (process-group kill alone fails).
claim = secrets.token_hex(32)
program = 'import os,time; p=os.fork(); (os.setsid(),print(os.getpid(),flush=True),time.sleep(60)) if p == 0 else time.sleep(.2)'
result = subprocess.run([controller, 'run', claim, 'read', '/usr/bin/python3', '-c', program], capture_output=True, text=True, timeout=10, check=True)
descendant = int(result.stdout.strip())
assert proof(claim)['exit_code'] == 0
assert not pathlib.Path(f'/proc/{descendant}').exists(), 'detached descendant survived proof'

# Explicit cancellation produces the same exact persisted proof.
claim = secrets.token_hex(32)
child = subprocess.Popen([controller, 'run', claim, 'read', '/bin/sh', '-c', 'echo ready; exec /bin/sleep 60'], stdout=subprocess.PIPE, text=True)
assert child.stdout.readline().strip() == 'ready'
value = proof(claim)
assert value['signal'] != 0
assert child.wait(timeout=10) == 0
assert proof(claim) == value
print('controller_cwd_replay_unknown_detached_descendant_cancel=passed')
