"""Run the app's actual notification delegate with offline boundary doubles.

The fixture replaces Apple notification delivery, Capacitor and authenticated
I/O. Swift concurrency, dispatch and approval validation use production code.
No simulator, credential, backend or model is used.
"""

from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
app = root / "frontend/ios/App"
source = (app / "App/AppDelegate.swift").read_text()
delegate = source.split("private class BackgroundApprovalDelegate:", 1)[1]
delegate = "private class BackgroundApprovalDelegate:" + delegate.split(
    "// Kept in the App target", 1
)[0]
fixture = (app / "Tests/BackgroundApprovalDelegateTests.swift").read_text()

with tempfile.TemporaryDirectory(prefix="mitzo-notification-actions-") as directory:
    temp = Path(directory)
    shared = root / "frontend/ios/MitzoShared/Sources/MitzoShared"
    subprocess.run([
        "xcrun", "swiftc", "-swift-version", "6",
        "-module-cache-path", str(temp / "cache"),
        "-emit-module", "-emit-library", "-module-name", "MitzoShared",
        "-emit-module-path", str(temp / "MitzoShared.swiftmodule"),
        *map(str, sorted(shared.rglob("*.swift"))),
        "-o", str(temp / "libMitzoShared.dylib"),
    ], check=True, timeout=120)
    main = temp / "main.swift"
    main.write_text(fixture.replace("// DELEGATE_IMPLEMENTATION", delegate))
    binary = temp / "notification-actions"
    subprocess.run([
        "xcrun", "swiftc", "-swift-version", "5",
        "-module-cache-path", str(temp / "cache"),
        "-I", str(temp), "-L", str(temp), "-lMitzoShared",
        "-Xlinker", "-rpath", "-Xlinker", str(temp),
        str(main), "-o", str(binary),
    ], check=True, timeout=120)
    subprocess.run([
        str(binary), "-mitzo_notification_server_url", "https://fixture.invalid",
    ], check=True, timeout=30)
