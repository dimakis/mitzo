"""Offline process fixtures for the native smoke's cold-boot wait."""

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
