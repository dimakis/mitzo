"""Offline command fixtures for the complete Apple check owner."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('ci-native-candidate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def test_all_existing_checks_run_with_the_exact_owned_build_path(self):
        calls=[]
        def run(command, **options):
            calls.append(command)
            self.assertTrue(options['check'])
            self.assertLessEqual(options['timeout'],1200)
        candidate.build_native_candidate(Path('/owned/build'), run=run)
        self.assertEqual([c[1] for c in calls if c[0] == candidate.sys.executable],[
            'scripts/test-keychain-helper.py', 'scripts/test-watch-chat-receipts.py',
            'scripts/test-watch-approval-ui.py','scripts/check-watch-bundle.py'])
        self.assertIn(['swift','test','--package-path','frontend/ios/MitzoShared'],calls)
        build=next(c for c in calls if c[0]=='xcodebuild')
        self.assertEqual(build[build.index('-derivedDataPath')+1],'/owned/build')
        self.assertEqual(calls[-1][-1],'/owned/build/Build/Products/Debug-iphonesimulator/App.app')

    def test_failures_still_build_diagnostics_and_never_turn_into_success(self):
        calls=[]
        def run(command, **options):
            calls.append(command)
            if len(calls)==1: raise subprocess.CalledProcessError(1,command)
        with self.assertRaisesRegex(RuntimeError,'keychain'):
            candidate.build_native_candidate(Path('/owned/build'),run=run)
        self.assertEqual(len(calls),6)

    def test_cancellation_stops_remaining_work(self):
        calls=[]
        def run(command, **options):
            calls.append(command)
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt): candidate.build_native_candidate(Path('/owned/build'),run=run)
        self.assertEqual(len(calls),1)


if __name__ == '__main__': unittest.main()
