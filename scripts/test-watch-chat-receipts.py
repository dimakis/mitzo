"""Exercise the real Watch view model offline with only its transport owner stubbed.

Compile actual Shared sources and typecheck against the Watch SDK. No app,
simulator, relay, network, provider, credential or system trust setting is used.
"""
import os
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
shared = root / "frontend/ios/MitzoShared/Sources/MitzoShared"
sources = sorted(str(path) for path in shared.rglob("*.swift"))
view_model = root / "frontend/ios/MitzoWatch/Services/ChatViewModel.swift"
harness = root / "frontend/ios/MitzoWatch/Tests/ChatViewModelReceiptTests.swift"


def run(args):
    subprocess.run(args, check=True, cwd=root, timeout=120)


with tempfile.TemporaryDirectory(prefix="mitzo-watch-receipts-") as folder:
    temp = pathlib.Path(folder)
    cache = str(temp / "cache")
    module = temp / "mac"
    module.mkdir()
    # Isolated real Shared build products avoid depending on SwiftPM/Xcode's
    # differing artifact layouts. The production implementation is never copied.
    run(["xcrun", "swiftc", "-swift-version", "6", "-module-cache-path", cache,
         "-emit-module", "-emit-library", "-module-name", "MitzoShared",
         "-emit-module-path", str(module / "MitzoShared.swiftmodule"),
         *sources, "-o", str(module / "libMitzoShared.dylib")])
    binary = temp / "receipts"
    run(["xcrun", "swiftc", "-swift-version", "6", "-module-cache-path", cache,
         "-I", str(module), "-L", str(module), "-lMitzoShared",
         "-Xlinker", "-rpath", "-Xlinker", str(module),
         str(view_model), str(harness), "-o", str(binary)])
    fixture = temp / "watch-startup.json"
    fixture_env = {**os.environ, "MITZO_WATCH_STARTUP_FIXTURE_OUTPUT": str(fixture)}
    subprocess.run(["npm", "test", "--", "server/__tests__/watch-new-session-startup.test.ts"],
                   check=True, cwd=root, env=fixture_env, timeout=120)
    legacy = root / "server/__tests__/fixtures/watch-startup-legacy-wire.json"
    run([str(binary), str(fixture), str(legacy)])

    sdk = subprocess.check_output(
        ["xcrun", "--sdk", "watchsimulator", "--show-sdk-path"], text=True, timeout=10,
    ).strip()
    watch = temp / "watch"
    watch.mkdir()
    target = "arm64-apple-watchos10.0-simulator"
    run(["xcrun", "swiftc", "-swift-version", "6", "-module-cache-path", cache,
         "-sdk", sdk, "-target", target, "-emit-module", "-module-name", "MitzoShared",
         "-emit-module-path", str(watch / "MitzoShared.swiftmodule"), *sources])
    run(["xcrun", "swiftc", "-swift-version", "6", "-module-cache-path", cache,
         "-sdk", sdk, "-target", target, "-I", str(watch), "-typecheck",
         str(view_model), str(harness)])
print("Actual Watch SDK receipt typecheck passed; no simulator launched")
