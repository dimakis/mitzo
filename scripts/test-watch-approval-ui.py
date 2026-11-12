"""Typecheck the complete Watch UI and real shared relay against the Watch SDK.

Uses isolated compiler output only: no simulator, server, credentials or models.
"""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
shared = root / 'frontend/ios/MitzoShared/Sources/MitzoShared'
watch = root / 'frontend/ios/MitzoWatch'
shared_sources = sorted(str(path) for path in shared.rglob('*.swift'))
sdk = subprocess.check_output(['xcrun', '--sdk', 'watchsimulator', '--show-sdk-path'], text=True).strip()
with tempfile.TemporaryDirectory(prefix='mitzo-watch-approvals-') as folder:
    output = pathlib.Path(folder)
    common = ['xcrun', 'swiftc', '-swift-version', '6', '-disable-sandbox', '-module-cache-path', str(output / 'cache'),
              '-sdk', sdk, '-target', 'arm64-apple-watchos10.0-simulator']
    subprocess.run([*common, '-emit-module', '-module-name', 'MitzoShared',
                    '-emit-module-path', str(output / 'MitzoShared.swiftmodule'),
                    *shared_sources], check=True, cwd=root, timeout=120)
    # The physical Watch uses 32-bit Int even on arm64_32; simulator-only
    # checks miss integer literals that cannot compile for the device.
    device = output / 'device'
    device.mkdir()
    device_sdk = subprocess.check_output(['xcrun', '--sdk', 'watchos', '--show-sdk-path'], text=True).strip()
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-disable-sandbox',
                    '-module-cache-path', str(output / 'cache'), '-sdk', device_sdk,
                    '-target', 'arm64_32-apple-watchos10.0', '-emit-module', '-module-name', 'MitzoShared',
                    '-emit-module-path', str(device / 'MitzoShared.swiftmodule'),
                    *shared_sources], check=True, cwd=root, timeout=120)
    # Watch-only checks do not compile the iPhone half of WatchConnectivity.
    ios = output / 'ios'
    ios.mkdir()
    ios_sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-disable-sandbox',
                    '-module-cache-path', str(output / 'cache'), '-sdk', ios_sdk,
                    '-target', 'arm64-apple-ios15.0-simulator', '-emit-module', '-module-name', 'MitzoShared',
                    '-emit-module-path', str(ios / 'MitzoShared.swiftmodule'),
                    *shared_sources], check=True, cwd=root, timeout=120)
    sources = sorted(str(path) for path in watch.rglob('*.swift') if 'Tests' not in path.parts)
    subprocess.run([*common, '-I', str(output), '-parse-as-library', '-typecheck', *sources],
                   check=True, cwd=root, timeout=120)
print('Complete Watch approval UI typecheck passed')
