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
from typing import Optional
from pathlib import Path

ORIGIN = "https://mitzo-notification-test.invalid"
LOG_LIMIT = 64 * 1024


def simctl(*args: str, timeout: int = 180) -> str:
    return subprocess.check_output(["xcrun", "simctl", *args], text=True, timeout=timeout).strip()


def launch_app(device: str, bundle_id: str) -> str:
    # First launch can still wait on cold LaunchServices after bootstatus returns.
    # Issue one command for this owned fixture; a timeout remains a failure.
    return simctl("launch", device, bundle_id, timeout=600)


def wait_for_bridge(preferences: Path) -> None:
    # WebKit processes start separately from the native app on a cold simulator.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if preferences.exists():
            with preferences.open("rb") as source:
                if plistlib.load(source).get("mitzo_notification_server_url") == ORIGIN:
                    return
        time.sleep(0.5)
    raise RuntimeError("Web-to-native notification bridge did not configure its server origin")


def wait_for_boot(device: str) -> None:
    # A fresh hosted runner can spend several minutes migrating its simulator
    # data on first boot. Stream progress and keep this wait separate from the
    # shorter command and bridge-configuration deadlines.
    subprocess.run(
        ["xcrun", "simctl", "bootstatus", device, "-b"], check=True, timeout=600
    )


def capture_failure(
    device: Optional[str],
    bundle_id: Optional[str],
    preferences: Optional[Path],
    stage: str,
    error: BaseException,
    root: Path,
    process_id: Optional[int],
) -> Path:
    """Best-effort evidence for this fresh offline simulator only, before deletion."""
    root.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="attempt-", dir=root))
    report = {
        "device": device,
        "bundle_id": bundle_id,
        "stage": stage,
        "failure": type(error).__name__,
        "message": str(error),
        "expected_origin": ORIGIN,
        "observed_origin": None,
        "probes": [],
    }
    if preferences is not None:
        try:
            if preferences.exists():
                with preferences.open("rb") as source:
                    value = plistlib.load(source).get("mitzo_notification_server_url")
                if isinstance(value, str):
                    report["observed_origin"] = value
        except Exception as failure:
            report["preferences_error"] = type(failure).__name__
    predicate = (
        f"processIdentifier == {process_id}"
        if process_id is not None else 'process == "App"'
    )
    probes = [
        (
            "screenshot",
            ["xcrun", "simctl", "io", device, "screenshot", str(evidence / "screenshot.png")],
            "screenshot-command.log",
        ),
        (
            "app_log",
            ["xcrun", "simctl", "spawn", device, "log", "show", "--style", "compact",
             "--last", "1m", "--predicate", predicate],
            "app.log",
        ),
    ]
    if device is None:
        probes = []  # A pre-allocation failure must not probe any other simulator.
    for name, command, filename in probes:
        result = {"name": name}
        with tempfile.TemporaryFile() as output:
            try:
                completed = subprocess.run(
                    command, stdout=output, stderr=subprocess.STDOUT, timeout=15, check=False
                )
                result["exit_code"] = completed.returncode
            except Exception as failure:
                result["error"] = type(failure).__name__
            output.seek(0)
            (evidence / filename).write_bytes(output.read(LOG_LIMIT))
            result["truncated"] = bool(output.read(1))
        report["probes"].append(result)
    (evidence / "failure.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Native failure evidence retained at {evidence}", file=sys.stderr)
    return evidence


def smoke(
    app: Path, diagnostics_root: Path = Path("test-results/native-notification")
) -> None:
    failed = False
    bundle_id = None
    preferences = None
    process_id = None
    device = None
    stage = "runtimes"
    evidence = None
    try:
        runtimes = json.loads(simctl("list", "runtimes", "--json"))["runtimes"]
        available = [r for r in runtimes if r["isAvailable"] and ".iOS-" in r["identifier"]]
        if not available:
            raise RuntimeError("An installed iOS simulator runtime is required")
        runtime = sorted(available, key=lambda r: tuple(map(int, r["version"].split("."))))[-1]
        stage = "create"
        device = simctl(
            "create", "Mitzo offline notification smoke",
            "com.apple.CoreSimulator.SimDeviceType.iPhone-16", runtime["identifier"]
        )
        stage = "prepare"
        with tempfile.TemporaryDirectory(prefix="mitzo-native-notifications-") as temporary:
            copied = Path(temporary) / "App.app"
            shutil.copytree(app, copied, symlinks=True)
            config_path = copied / "capacitor.config.json"
            config = json.loads(config_path.read_text())
            config.pop("server", None)  # No remote page can override the fixture.
            config_path.write_text(json.dumps(config))
            core = (
                Path(__file__).resolve().parent.parent
                / "node_modules/@capacitor/core/dist/index.js"
            )
            shutil.copyfile(core, copied / "public" / "capacitor-core-smoke.js")
            (copied / "public" / "index.html").write_text(f"""<!doctype html>
<html><head><meta charset="utf-8"></head><body>Offline notification bridge test<p id="status">Loading fixture</p>
<script type="module">
import {{ registerPlugin }} from './capacitor-core-smoke.js';
window.addEventListener('load', async () => {{
  try {{
    document.getElementById('status').textContent = 'Calling notification bridge';
    await registerPlugin('WatchAuthBridge').configureNotificationServer({{ url: '{ORIGIN}' }});
    document.getElementById('status').textContent = 'Bridge call completed';
  }} catch (error) {{
    document.getElementById('status').textContent = 'Bridge call failed: ' + String(error);
    console.error('Notification bridge smoke failed', error);
  }}
}});
</script></body></html>""")
            with (copied / "Info.plist").open("rb") as source:
                bundle_id = plistlib.load(source)["CFBundleIdentifier"]
            print("Booting an isolated iPhone simulator for the offline bridge test.", flush=True)
            stage = "boot"
            simctl("boot", device)
            wait_for_boot(device)
            stage = "install"
            simctl("install", device, str(copied))
            stage = "launch"
            launch = launch_app(device, bundle_id)
            pid = launch.rsplit(":", 1)[-1].strip()
            process_id = int(pid) if pid.isdecimal() else None
            container = Path(simctl("get_app_container", device, bundle_id, "data"))
            preferences = container / "Library" / "Preferences" / f"{bundle_id}.plist"
            stage = "bridge"
            wait_for_bridge(preferences)
            print("Real web-to-native notification configuration succeeded.")
            return
    except BaseException as error:
        failed = True
        try:
            evidence = capture_failure(
                device, bundle_id, preferences, stage, error, diagnostics_root, process_id
            )
        except Exception as capture_error:
            print(f"Native evidence capture failed: {type(capture_error).__name__}", file=sys.stderr)
        raise
    finally:
        if device is not None:
            cleanup_errors = []
            try:
                shutdown = subprocess.run(
                    ["xcrun", "simctl", "shutdown", device], check=False, timeout=60
                )
                if shutdown.returncode:
                    cleanup_errors.append("shutdown returned nonzero")
            except Exception as error:
                cleanup_errors.append(f"shutdown: {type(error).__name__}")
            # Preserve evidence for cleanup-only failures before attempting deletion.
            if cleanup_errors and not failed:
                try:
                    evidence = capture_failure(
                        device, bundle_id, preferences, "cleanup",
                        RuntimeError("; ".join(cleanup_errors)), diagnostics_root, process_id,
                    )
                except Exception as error:
                    print(f"Native evidence capture failed: {type(error).__name__}", file=sys.stderr)
            try:
                simctl("delete", device)
            except Exception as error:
                cleanup_errors.append(f"delete: {type(error).__name__}")
                if evidence is None and not failed:
                    try:
                        evidence = capture_failure(
                            device, bundle_id, preferences, "cleanup", error,
                            diagnostics_root, process_id,
                        )
                    except Exception as capture_error:
                        print(
                            f"Native evidence capture failed: {type(capture_error).__name__}",
                            file=sys.stderr,
                        )
            if cleanup_errors:
                message = "Native fixture cleanup failed: " + "; ".join(cleanup_errors)
                if evidence is not None:
                    try:
                        (evidence / "cleanup.json").write_text(json.dumps(cleanup_errors) + "\n")
                    except Exception as error:
                        print(f"Native cleanup evidence failed: {type(error).__name__}", file=sys.stderr)
                if failed:
                    print(message, file=sys.stderr)
                else:
                    raise RuntimeError(message)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument(
        "--diagnostics-dir", type=Path, default=Path("test-results/native-notification")
    )
    args = parser.parse_args()
    smoke(args.app.resolve(), args.diagnostics_dir)
