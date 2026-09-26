"""Offline bootstrap security tests; never invoke a model or Codex."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader('launcher', str(Path(__file__).with_name('symposium-subscription-app-server')))
spec = importlib.util.spec_from_loader(loader.name, loader)
launcher = importlib.util.module_from_spec(spec)
loader.exec_module(launcher)


class BootstrapTest(unittest.TestCase):
    def env(self):
        home = '/sandbox/.symposium-seats/' + 'a' * 64
        return {'HOME': home, 'CODEX_HOME': home + '/.codex',
                'CODEX_AUTH_ACCESS_TOKEN': 'openshell:resolve:env:s' + 'b' * 64 + '_CODEX_AUTH_ACCESS_TOKEN',
                'CODEX_AUTH_ACCOUNT_ID': 'openshell:resolve:env:v12_CODEX_AUTH_ACCOUNT_ID',
                'OPENAI_API_KEY': 'must-not-pass', 'ANTHROPIC_API_KEY': 'must-not-pass',
                'CODEX_AUTH_REFRESH_TOKEN': 'must-not-pass', 'PYTHONPATH': 'must-not-pass',
                'HTTPS_PROXY': 'http://supervisor:3128'}

    def test_stdio_exec_auth_and_environment(self):
        with patch.object(launcher, 'private_directory', return_value=123), \
             patch.object(launcher.os, 'close'), patch.object(launcher.os, 'umask'), \
             patch.object(launcher, 'write_auth') as write, \
             patch.object(launcher.os, 'execve') as execute:
            launcher.launch(self.env())
        auth = write.call_args.args[1]
        self.assertEqual(auth['auth_mode'], 'chatgptAuthTokens')
        self.assertEqual(auth['tokens']['refresh_token'], '')
        self.assertEqual(auth['tokens']['access_token'], self.env()['CODEX_AUTH_ACCESS_TOKEN'])
        binary, argv, env = execute.call_args.args
        self.assertEqual(binary, '/usr/bin/codex')
        self.assertEqual(argv[1:3], ['app-server', '--stdio'])
        self.assertNotIn('--listen', argv)
        self.assertIn('openai_base_url=""', argv)
        self.assertIn('chatgpt_base_url="https://chatgpt.com/backend-api/"', argv)
        self.assertIn('forced_login_method="chatgpt"', argv)
        self.assertNotIn('must-not-pass', json.dumps(env))
        self.assertEqual(env['HTTPS_PROXY'], 'http://supervisor:3128')

    def test_reject_raw_alias_wrong_key_and_revision_access(self):
        for value in ['raw-secret', 'openshell:resolve:env:CODEX_AUTH_ACCESS_TOKEN',
                      'openshell:resolve:env:v2_CODEX_AUTH_ACCESS_TOKEN',
                      'openshell:resolve:env:s' + 'a' * 64 + '_OTHER_KEY']:
            env = self.env()
            env['CODEX_AUTH_ACCESS_TOKEN'] = value
            with self.assertRaises(ValueError):
                launcher.launch(env)

    def test_reject_shared_home(self):
        env = self.env()
        env['HOME'] = '/sandbox/workdir'
        with self.assertRaises(ValueError):
            launcher.launch(env)

    def test_linux_ancestor_traversal_uses_path_only(self):
        path_flag = 0x200000
        info = type('Info', (), {'st_uid': os.geteuid(), 'st_mode': 0o40700})()
        with patch.object(launcher.os, 'O_PATH', path_flag, create=True), \
             patch.object(launcher.os, 'open', side_effect=[10, 11, 12, 13]) as opened, \
             patch.object(launcher.os, 'mkdir'), patch.object(launcher.os, 'close'), \
             patch.object(launcher.os, 'fstat', return_value=info):
            self.assertEqual(launcher.private_directory('/sandbox/seats/private'), 13)
        self.assertTrue(all(call.args[1] & path_flag for call in opened.call_args_list[:-1]))
        self.assertFalse(opened.call_args_list[-1].args[1] & path_flag)
        self.assertTrue(all(call.args[1] & os.O_NOFOLLOW for call in opened.call_args_list[1:]))

    def test_private_directory_and_auth_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            private = str(Path(tmp).resolve() / 'private')
            fd = launcher.private_directory(private)
            try:
                launcher.write_auth(fd, {'only': 'opaque'})
            finally:
                os.close(fd)
            self.assertEqual(os.stat(private).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(private + '/auth.json').st_mode & 0o777, 0o600)

    def test_reject_symlink_directory_and_auth(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'real').mkdir(mode=0o700)
            (root / 'link').symlink_to(root / 'real')
            with self.assertRaises(OSError):
                launcher.private_directory(str(root / 'link'))
            (root / 'real' / 'auth.json').symlink_to(root / 'untouched')
            fd = launcher.private_directory(str(root / 'real'))
            try:
                with self.assertRaises(ValueError):
                    launcher.write_auth(fd, {})
            finally:
                os.close(fd)
            self.assertFalse((root / 'untouched').exists())

    def test_restart_replaces_only_safe_regular_auth(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            fd = launcher.private_directory(str(root))
            try:
                launcher.write_auth(fd, {'first': True})
                launcher.write_auth(fd, {'second': True})
                self.assertEqual(json.loads((root / 'auth.json').read_text()), {'second': True})
                os.link(root / 'auth.json', root / 'hardlink')
                with self.assertRaises(ValueError):
                    launcher.write_auth(fd, {})
            finally:
                os.close(fd)

    def test_reject_unsafe_directory_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / 'public'
            root.mkdir(mode=0o755)
            root.chmod(0o755)
            with self.assertRaises(ValueError):
                launcher.private_directory(str(root))


if __name__ == '__main__':
    unittest.main()
