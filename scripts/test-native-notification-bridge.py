"""Exercise the real Capacitor notification bridge in a disposable simulator.

The copied app uses an offline page and an empty simulator Keychain. It neither
contacts a Mitzo backend nor reuses an existing simulator or connected account.
"""

import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ORIGIN = "https://mitzo-notification-test.invalid"


def simctl(*args: str) -> str:
    return subprocess.check_output(["xcrun", "simctl", *args], text=True, timeout=180).strip()


def wait_for_boot(device: str) -> None:
    # A fresh hosted runner can spend several minutes migrating its simulator
    # data on first boot. Stream progress and keep this wait separate from the
    # shorter command and bridge-configuration deadlines.
    subprocess.run(
        ["xcrun", "simctl", "bootstatus", device, "-b"], check=True, timeout=600
    )


def smoke(app: Path) -> None:
    runtimes = json.loads(simctl("list", "runtimes", "--json"))["runtimes"]
    available = [r for r in runtimes if r["isAvailable"] and ".iOS-" in r["identifier"]]
    if not available:
        raise RuntimeError("An installed iOS simulator runtime is required")
    runtime = sorted(available, key=lambda r: tuple(map(int, r["version"].split("."))))[-1]
    device = simctl("create", "Mitzo offline notification smoke", "com.apple.CoreSimulator.SimDeviceType.iPhone-16", runtime["identifier"])
    try:
        with tempfile.TemporaryDirectory(prefix="mitzo-native-notifications-") as temporary:
            copied = Path(temporary) / "App.app"
            shutil.copytree(app, copied, symlinks=True)
            config_path = copied / "capacitor.config.json"
            config = json.loads(config_path.read_text())
            config.pop("server", None)  # No remote page can override the fixture.
            config_path.write_text(json.dumps(config))
            core = Path(__file__).resolve().parent.parent / "node_modules" / "@capacitor" / "core" / "dist" / "index.js"
            shutil.copyfile(core, copied / "public" / "capacitor-core-smoke.js")
            (copied / "public" / "index.html").write_text(f"""<!doctype html>
<html><head><meta charset="utf-8"></head><body>Offline notification bridge test
<script type="module">
import {{ registerPlugin }} from './capacitor-core-smoke.js';
window.addEventListener('load', async () => {{
  try {{
    await registerPlugin('WatchAuthBridge').configureNotificationServer({{ url: '{ORIGIN}' }});
  }} catch (error) {{ console.error('Notification bridge smoke failed', error); }}
}});
</script></body></html>""")
            with (copied / "Info.plist").open("rb") as source:
                bundle_id = plistlib.load(source)["CFBundleIdentifier"]
            print("Booting an isolated iPhone simulator for the offline bridge test.", flush=True)
            simctl("boot", device)
            wait_for_boot(device)
            simctl("install", device, str(copied))
            simctl("launch", device, bundle_id)
            container = Path(simctl("get_app_container", device, bundle_id, "data"))
            preferences = container / "Library" / "Preferences" / f"{bundle_id}.plist"
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if preferences.exists():
                    with preferences.open("rb") as source:
                        if plistlib.load(source).get("mitzo_notification_server_url") == ORIGIN:
                            print("Real web-to-native notification configuration succeeded.")
                            return
                time.sleep(0.5)
            raise RuntimeError("Web-to-native notification bridge did not configure its server origin")
    finally:
        subprocess.run(["xcrun", "simctl", "shutdown", device], check=False, timeout=60)
        simctl("delete", device)


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve())
