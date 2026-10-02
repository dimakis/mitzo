"""Offline bootstrap contract tests: fake handles/identity, no native/model calls."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('symposium-subscription-identity-app-server')
loader = importlib.machinery.SourceFileLoader('identity_bootstrap', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
bootstrap = importlib.util.module_from_spec(spec)
loader.exec_module(bootstrap)
CLAIM = 'a' * 64
HOME = '/sandbox/.symposium-seats/' + CLAIM
IDENTITY = {'version': 1, 'claim': CLAIM, 'accountId': 'verified-account_42'}


def environment():
    return {'HOME': HOME, 'CODEX_HOME': HOME + '/.codex',
            'CODEX_AUTH_ACCESS_TOKEN': 'openshell:resolve:env:s' + 'b' * 64 + '_CODEX_AUTH_ACCESS_TOKEN',
            'CODEX_AUTH_ACCOUNT_ID': 'openshell:resolve:env:v1_CODEX_AUTH_ACCOUNT_ID',
            'OPENAI_API_KEY': 'fake-key-must-not-pass', 'CODEX_AUTH_REFRESH_TOKEN': 'fake-refresh-must-not-pass',
            'LD_PRELOAD': '/fake-preload', 'HTTPS_PROXY': 'http://proxy.invalid'}


def frame(value=IDENTITY):
    return json.dumps(value).encode('ascii') + b'\n'


class IdentityContract(unittest.TestCase):
    def setUp(self):
        self.original_umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.original_umask)

    def read(self, data, env=None):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, data)
            os.close(write_fd)
            write_fd = None
            return bootstrap.verified_identity(env or environment(), read_fd, timeout=0.2)
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

    def test_exact_frame_leaves_initialize_bytes(self):
        read_fd, write_fd = os.pipe()
        initialize = b'{"id":1,"method":"initialize","params":{}}\n'
        try:
            os.write(write_fd, frame() + initialize)
            self.assertEqual(bootstrap.verified_identity(environment(), read_fd), IDENTITY['accountId'])
            self.assertEqual(os.read(read_fd, 4096), initialize)
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_exact_512_byte_frame_accepted_513_refused(self):
        raw = frame()
        self.assertEqual(self.read(b' ' * (512 - len(raw)) + raw), IDENTITY['accountId'])
        with self.assertRaises(ValueError):
            self.read(b' ' * (513 - len(raw)) + raw)

    def test_malformed_frames_fail_closed(self):
        malformed = [b'', b'{}\n', b'not-json\n', b'[]\n', b'null\n',
            frame()[:-1], b'\xff\n', b'x' * 513,
            b'{"version":1,"version":1,"claim":"' + CLAIM.encode() + b'","accountId":"a"}\n']
        for change in ({'version': True}, {'version': '1'}, {'version': 2},
                       {'claim': CLAIM.upper()}, {'claim': 'c' * 64}, {'claim': None},
                       {'accountId': ''}, {'accountId': '-bad'}, {'accountId': 'a' * 129},
                       {'accountId': 'a/b'}, {'accountId': '\u00e9'}, {'accountId': 42},
                       {'extra': 'not-allowed'}):
            malformed.append(frame({**IDENTITY, **change}))
        for data in malformed:
            with self.subTest(case=len(data)):
                with self.assertRaises(ValueError):
                    self.read(data)

    def test_total_deadline_applies_to_slow_trickle(self):
        read_fd, write_fd = os.pipe()
        finished = threading.Event()
        def trickle():
            while not finished.wait(0.02):
                os.write(write_fd, b' ')
        thread = threading.Thread(target=trickle)
        thread.start()
        started = time.monotonic()
        try:
            with self.assertRaises(ValueError):
                bootstrap.verified_identity(environment(), read_fd, timeout=0.12)
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            finished.set()
            thread.join()
            os.close(read_fd)
            os.close(write_fd)

    def test_silent_open_pipe_times_out(self):
        read_fd, write_fd = os.pipe()
        try:
            with self.assertRaises(ValueError):
                bootstrap.verified_identity(environment(), read_fd, timeout=0.03)
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_real_entrypoint_errors_are_static(self):
        # The dynamic loader acts before Python/our launcher. Trusted spawning
        # strips ambient preload settings; exercise launcher diagnostics alone.
        child_env = {**environment(), 'PATH': '/usr/bin:/bin'}
        del child_env['LD_PRELOAD']
        result = subprocess.run([sys.executable, '-I', '-B', str(SOURCE)],
            input=b'{"accountId":"private-identity-must-not-print"}\n',
            env=child_env, capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'subscription bootstrap refused unsafe or unavailable state\n')

    def test_launch_uses_verified_account_and_atomic_private_auth(self):
        with tempfile.TemporaryDirectory() as temporary:
            local = Path(temporary).resolve()
            (local / '.codex').mkdir(mode=0o700)
            original_private_directory = bootstrap.private_directory
            def private_directory(path):
                return original_private_directory(str(local / '.codex') if path.endswith('/.codex') else str(local))
            identity_reader = bootstrap.verified_identity
            read_fd, write_fd = os.pipe()
            try:
                os.write(write_fd, frame())
                with patch.object(bootstrap, 'private_directory', private_directory), \
                     patch.object(bootstrap, 'verified_identity', lambda env: identity_reader(env, read_fd)), \
                     patch.object(bootstrap.os, 'execve') as execute:
                    bootstrap.launch(environment())
                binary, arguments, child = execute.call_args.args
                self.assertEqual(binary, '/usr/bin/codex')
                self.assertEqual(arguments, bootstrap.ARGV)
                self.assertIn('forced_login_method="chatgpt"', arguments)
                self.assertIn('openai_base_url=""', arguments)
                self.assertIn('chatgpt_base_url="https://chatgpt.com/backend-api/"', arguments)
                self.assertIn('features.enable_request_compression=false', arguments)
                self.assertEqual(child['HTTPS_PROXY'], 'http://proxy.invalid')
                self.assertNotIn('OPENAI_API_KEY', child)
                self.assertNotIn('LD_PRELOAD', child)
                self.assertNotIn('CODEX_AUTH_ACCESS_TOKEN', child)
                self.assertNotIn('CODEX_AUTH_REFRESH_TOKEN', child)
                auth_path = local / '.codex/auth.json'
                auth = json.loads(auth_path.read_text())
                self.assertEqual(auth['tokens']['account_id'], IDENTITY['accountId'])
                self.assertEqual(auth['tokens']['access_token'], environment()['CODEX_AUTH_ACCESS_TOKEN'])
                self.assertEqual(auth['tokens']['refresh_token'], '')
                self.assertEqual(stat.S_IMODE(auth_path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE((local / '.codex').stat().st_mode), 0o700)
                self.assertEqual(list((local / '.codex').glob('.auth-*')), [])
                # An unsafe existing auth file must not be replaced or followed.
                auth_path.chmod(0o644)
                directory_fd = original_private_directory(str(local / '.codex'))
                try:
                    with self.assertRaises(ValueError):
                        bootstrap.write_auth(directory_fd, auth)
                    auth_path.unlink()
                    outside = local / 'outside'
                    outside.write_text('unchanged')
                    auth_path.symlink_to(outside)
                    with self.assertRaises(ValueError):
                        bootstrap.write_auth(directory_fd, auth)
                    self.assertEqual(outside.read_text(), 'unchanged')
                    auth_path.unlink()
                    outside.chmod(0o600)
                    os.link(outside, auth_path)
                    with self.assertRaises(ValueError):
                        bootstrap.write_auth(directory_fd, auth)
                finally:
                    os.close(directory_fd)
            finally:
                os.close(read_fd)
                os.close(write_fd)

    def test_unsafe_homes_and_raw_handles_refuse_before_filesystem_or_exec(self):
        changes = [{'HOME': '/host/home'}, {'HOME': HOME + '/escape'}, {'CODEX_HOME': '/host/.codex'},
                   {'CODEX_AUTH_ACCOUNT_ID': 'raw-account'}, {'CODEX_AUTH_ACCESS_TOKEN': 'raw-token'},
                   {'CODEX_AUTH_ACCESS_TOKEN': 'openshell:resolve:env:v1_CODEX_AUTH_ACCESS_TOKEN'}]
        for change in changes:
            with self.subTest(keys=list(change)):
                with patch.object(bootstrap, 'private_directory') as private, \
                     patch.object(bootstrap.os, 'execve') as execute:
                    with self.assertRaises(ValueError):
                        bootstrap.launch({**environment(), **change})
                    private.assert_not_called()
                    execute.assert_not_called()

    def test_private_directory_rejects_mode_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            local = Path(temporary).resolve()
            bad = local / 'bad'
            bad.mkdir(mode=0o755)
            bad.chmod(0o755)
            with self.assertRaises(ValueError):
                bootstrap.private_directory(str(bad))
            link = local / 'link'
            link.symlink_to(local, target_is_directory=True)
            with self.assertRaises(OSError):
                bootstrap.private_directory(str(link))


if __name__ == '__main__':
    unittest.main()
