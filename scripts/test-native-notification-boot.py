"""Offline process fixtures for the native smoke's cold-boot wait."""

import importlib.util
import json
import plistlib
import tempfile
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "notification_smoke", Path(__file__).with_name("test-native-notification-bridge.py")
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class ColdBootTests(unittest.TestCase):
    def test_a_four_minute_cold_boot_reaches_readiness_with_a_bounded_wait(self):
        calls = []

        def cold_boot(command, **options):
            calls.append(command)
            deadline = options["timeout"]
            self.assertLessEqual(deadline, 15 * 60)
            if deadline < 4 * 60:
                raise subprocess.TimeoutExpired(command, deadline)
            return subprocess.CompletedProcess(command, 0)

        with patch.object(smoke.subprocess, "run", side_effect=cold_boot), patch.object(
            smoke.subprocess,
            "check_output",
            side_effect=lambda command, **options: cold_boot(command, **options) and "Booted",
        ):
            smoke.wait_for_boot("owned-fixture-device")
        self.assertEqual(calls, [["xcrun", "simctl", "bootstatus", "owned-fixture-device", "-b"]])

    def test_boot_failure_still_fails_validation(self):
        failure = subprocess.CalledProcessError(1, ["xcrun", "simctl", "bootstatus"])
        with patch.object(smoke.subprocess, "run", side_effect=failure), patch.object(
            smoke.subprocess, "check_output", side_effect=failure
        ), self.assertRaises(subprocess.CalledProcessError):
            smoke.wait_for_boot("owned-fixture-device")

# These fixtures exercise only a copied offline page and mocked native commands.
class FailureEvidenceTests(unittest.TestCase):
    def test_preallocation_failure_has_metadata_without_probing_other_devices(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(smoke, 'simctl', return_value=json.dumps({'runtimes': []})) as command, patch.object(smoke.subprocess, 'run') as probe:
                with self.assertRaisesRegex(RuntimeError, 'runtime is required'):
                    smoke.smoke(root / 'unused.app', root / 'evidence')
            probe.assert_not_called()
            command.assert_called_once_with('list', 'runtimes', '--json')
            report = json.loads(next((root / 'evidence').glob('*/failure.json')).read_text())
            self.assertEqual(report['stage'], 'runtimes')
            self.assertIsNone(report['device'])
            self.assertEqual(report['probes'], [])

    def test_capture_is_scoped_bounded_and_retains_only_selected_preferences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preferences = root / 'preferences.plist'
            preferences.write_bytes(plistlib.dumps({
                'mitzo_notification_server_url': 'wrong',
                'private_key': 'must-not-export',
            }))
            calls = []
            def run(command, **options):
                calls.append(command)
                self.assertLessEqual(options['timeout'], 15)
                options['stdout'].write(b'fixture native log')
                if 'screenshot' in command:
                    Path(command[-1]).write_bytes(b'fixture PNG')
                return subprocess.CompletedProcess(command, 0)
            with patch.object(smoke.subprocess, 'run', side_effect=run):
                evidence = smoke.capture_failure(
                    'owned-device', 'com.mitzo.fixture', preferences, 'bridge',
                    RuntimeError('not configured'), root / 'evidence', 123,
                )
            report = json.loads((evidence / 'failure.json').read_text())
            self.assertEqual(report['stage'], 'bridge')
            self.assertEqual(report['observed_origin'], 'wrong')
            self.assertEqual(report['expected_origin'], smoke.ORIGIN)
            self.assertEqual(len(calls), 2)
            self.assertTrue(all('owned-device' in call for call in calls))
            self.assertIn('processIdentifier == 123', calls[1])
            self.assertEqual((evidence / 'screenshot.png').read_bytes(), b'fixture PNG')
            self.assertEqual((evidence / 'app.log').read_text(), 'fixture native log')
            self.assertNotIn('must-not-export', (evidence / 'failure.json').read_text())

    def test_diagnostic_command_failure_does_not_discard_metadata_or_next_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def run(command, **options):
                calls.append(command)
                if 'screenshot' in command:
                    raise subprocess.TimeoutExpired(command, options['timeout'])
                options['stdout'].write(b'available app log')
                return subprocess.CompletedProcess(command, 0)
            with patch.object(smoke.subprocess, 'run', side_effect=run):
                evidence = smoke.capture_failure(
                    'owned-device', None, None, 'boot',
                    RuntimeError('boot failed'), Path(directory), None,
                )
            report = json.loads((evidence / 'failure.json').read_text())
            self.assertEqual(len(calls), 2)
            self.assertEqual(report['probes'][0]['error'], 'TimeoutExpired')
            self.assertEqual((evidence / 'app.log').read_text(), 'available app log')

    def test_log_capture_is_truncated_and_attempt_directories_do_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            def run(command, **options):
                options['stdout'].write(b'x' * (smoke.LOG_LIMIT + 1))
                return subprocess.CompletedProcess(command, 0)
            with patch.object(smoke.subprocess, 'run', side_effect=run):
                first = smoke.capture_failure(
                    'owned-device', None, None, 'boot',
                    RuntimeError('one'), Path(directory), None,
                )
                second = smoke.capture_failure(
                    'owned-device', None, None, 'boot',
                    RuntimeError('two'), Path(directory), None,
                )
            self.assertNotEqual(first, second)
            self.assertEqual((first / 'app.log').stat().st_size, smoke.LOG_LIMIT)
            self.assertTrue(json.loads((first / 'failure.json').read_text())['probes'][1]['truncated'])

    def fixture(self, root):
        app = root / 'App.app'
        (app / 'public').mkdir(parents=True)
        (app / 'capacitor.config.json').write_text(json.dumps({
            'server': {'url': 'https://must-not-use.invalid'},
        }))
        (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'com.mitzo.fixture'}))
        container = root / 'container'
        preferences = container / 'Library/Preferences/com.mitzo.fixture.plist'
        preferences.parent.mkdir(parents=True)
        return app, container, preferences

    def test_smoke_captures_before_cleanup_and_keeps_original_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app, container, preferences = self.fixture(root)
            order = []
            def simctl(*args):
                order.append(args[0])
                if args[:2] == ('list', 'runtimes'):
                    return json.dumps({'runtimes': [{
                        'isAvailable': True, 'identifier': 'fixture.iOS-26', 'version': '26.0',
                    }]})
                if args[0] == 'install':
                    copied = Path(args[2])
                    self.assertNotIn('server', json.loads((copied / 'capacitor.config.json').read_text()))
                    self.assertIn('Calling notification bridge', (copied / 'public/index.html').read_text())
                if args[0] == 'create': return 'owned-device'
                if args[0] == 'get_app_container': return str(container)
                if args[0] == 'launch': return 'com.mitzo.fixture: 123'
                if args[0] == 'delete': raise RuntimeError('cleanup failed')
                return ''
            def capture(*args):
                order.append('capture')
                self.assertEqual(args[0], 'owned-device')
                raise OSError('evidence directory unavailable')
            def cleanup(command, **options):
                order.append('shutdown')
                raise subprocess.TimeoutExpired(command, options['timeout'])
            with (
                patch.object(smoke, 'simctl', side_effect=simctl),
                patch.object(smoke, 'wait_for_boot'),
                patch.object(smoke, 'capture_failure', side_effect=capture),
                patch.object(smoke.subprocess, 'run', side_effect=cleanup),
                patch.object(smoke.time, 'monotonic', side_effect=[0, 31]),
            ):
                with self.assertRaisesRegex(RuntimeError, 'did not configure'):
                    smoke.smoke(app, root / 'evidence')
            self.assertLess(order.index('capture'), order.index('shutdown'))
            self.assertLess(order.index('shutdown'), order.index('delete'))

    def test_success_has_no_failure_evidence_and_cleanup_failure_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app, container, preferences = self.fixture(root)
            preferences.write_bytes(plistlib.dumps({
                'mitzo_notification_server_url': smoke.ORIGIN,
            }))
            def simctl(*args):
                if args[:2] == ('list', 'runtimes'):
                    return json.dumps({'runtimes': [{
                        'isAvailable': True, 'identifier': 'fixture.iOS-26', 'version': '26.0',
                    }]})
                if args[0] == 'install':
                    copied = Path(args[2])
                    self.assertNotIn('server', json.loads((copied / 'capacitor.config.json').read_text()))
                    self.assertIn('Calling notification bridge', (copied / 'public/index.html').read_text())
                if args[0] == 'create': return 'owned-device'
                if args[0] == 'get_app_container': return str(container)
                if args[0] == 'launch': return 'com.mitzo.fixture: 123'
                return ''
            with (
                patch.object(smoke, 'simctl', side_effect=simctl),
                patch.object(smoke, 'wait_for_boot'),
                patch.object(smoke, 'capture_failure') as capture,
                patch.object(smoke.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)),
                patch.object(smoke.time, 'monotonic', side_effect=[0, 0]),
            ):
                smoke.smoke(app, root / 'evidence')
                capture.assert_not_called()
            with (
                patch.object(smoke, 'simctl', side_effect=simctl),
                patch.object(smoke, 'wait_for_boot'),
                patch.object(smoke, 'capture_failure') as capture,
                patch.object(smoke.subprocess, 'run', side_effect=OSError('shutdown failed')),
                patch.object(smoke.time, 'monotonic', side_effect=[0, 0]),
            ):
                with self.assertRaisesRegex(RuntimeError, 'cleanup'):
                    smoke.smoke(app, root / 'evidence')
                capture.assert_called_once()
                self.assertEqual(capture.call_args.args[3], 'cleanup')


if __name__ == "__main__":
    unittest.main()
