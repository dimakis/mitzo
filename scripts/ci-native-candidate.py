"""Own a cold simulator across every existing Apple check and the real bridge."""
import argparse
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys

spec = importlib.util.spec_from_file_location('notification_smoke', Path(__file__).with_name('test-native-notification-bridge.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def build_native_candidate(derived_data: Path, run=subprocess.run):
    app = derived_data / 'Build/Products/Debug-iphonesimulator/App.app'
    commands = [
        ('keychain', [sys.executable, 'scripts/test-keychain-helper.py'], 300),
        ('swift', ['swift', 'test', '--package-path', 'frontend/ios/MitzoShared'], 600),
        ('watch-receipts', [sys.executable, 'scripts/test-watch-chat-receipts.py'], 300),
        ('watch-approval', [sys.executable, 'scripts/test-watch-approval-ui.py'], 300),
        ('app-build', ['xcodebuild', '-project', 'frontend/ios/App/App.xcodeproj', '-scheme', 'App',
                       '-destination', 'generic/platform=iOS Simulator',
                       '-derivedDataPath', str(derived_data), 'CODE_SIGNING_ALLOWED=NO', 'build'], 1200),
        ('watch-bundle', [sys.executable, 'scripts/check-watch-bundle.py', str(app)], 180),
    ]
    failures = []
    for stage, command, timeout in commands:
        try:
            with smoke.native_stage(stage):
                run(command, check=True, timeout=timeout)
        except Exception as error:
            # Continue independent checks and the diagnostic build, retaining every
            # failed gate. BaseException cancellation stops admission immediately.
            failures.append(stage)
            print(f'CI_NATIVE_FAILURE {stage}: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
    if failures:
        raise RuntimeError('Required native checks failed: ' + ', '.join(failures))


def interrupted(signum, _frame):
    raise KeyboardInterrupt(f'Native candidate interrupted by signal {signum}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--derived-data', type=Path, required=True)
    parser.add_argument('--boot-mode', choices=['overlap', 'sequential'], default='overlap')
    parser.add_argument('--diagnostics-dir', type=Path, default=Path('test-results/native-notification'))
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    # Sequential is the same-candidate A/B control, with identical commands and checks.
    app = args.derived_data / 'Build/Products/Debug-iphonesimulator/App.app'
    with smoke.native_stage('total'):
        if args.boot_mode == 'sequential':
            build_native_candidate(args.derived_data)
            smoke.smoke(app, args.diagnostics_dir)
        else:
            smoke.smoke(app, args.diagnostics_dir, prepare=lambda: build_native_candidate(args.derived_data))
