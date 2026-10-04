#!/usr/bin/env python3
"""Disposable Linux container proof; no inference or network requests."""
import pathlib
import subprocess

task = pathlib.Path('/sandbox/workspaces/mgmt')
knowledge = pathlib.Path('/sandbox/workspaces/knowledge/scope-canary/mgmt')
task.mkdir(parents=True, exist_ok=True)
knowledge.mkdir(parents=True, exist_ok=True)
note = knowledge / 'accepted.md'
note.write_text('accepted')

child = r'''
import pathlib, subprocess, sys
task = pathlib.Path('/sandbox/workspaces/mgmt')
note = pathlib.Path('/sandbox/workspaces/knowledge/scope-canary/mgmt/accepted.md')
assert note.read_text() == 'accepted'
(task / 'draft.md').write_text('draft')
pathlib.Path('/sandbox/.codex/state-test').write_text('provider state')
pathlib.Path('/tmp/knowledge-scope-test').write_text('temporary')
note.chmod(0o666)  # changing mode must not bypass the inherited kernel rule
for candidate in [note, task / 'knowledge-link']:
 if candidate != note:
  candidate.symlink_to(note)
 try:
  candidate.write_text('corrupt')
 except PermissionError:
  pass
 else:
  raise AssertionError('knowledge write escaped restriction')
try:
 note.parent.rename(task / 'stolen-knowledge')
except PermissionError:
 pass
else:
 raise AssertionError('knowledge rename escaped restriction')
result = subprocess.run([sys.executable, '-I', '-c',
 "from pathlib import Path; Path('/sandbox/workspaces/knowledge/scope-canary/mgmt/accepted.md').write_text('background')"], capture_output=True)
assert result.returncode != 0
assert note.read_text() == 'accepted'
'''
subprocess.run(['/usr/libexec/mitzo/knowledge-write-scope', '/usr/bin/python3', '-I', '-c', child], check=True)
assert note.read_text() == 'accepted'
print('KNOWLEDGE_WRITE_SCOPE=pass')
