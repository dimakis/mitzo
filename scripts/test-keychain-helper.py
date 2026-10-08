"""Exercise the native helper against a disposable keychain, never the login keychain."""
import json
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="mitzo-keychain-test-") as folder:
    helper = pathlib.Path(folder) / "helper"
    keychain = str(pathlib.Path(folder) / "test.keychain-db")
    subprocess.run(["swiftc", "-module-cache-path", str(pathlib.Path(folder) / "cache"), "-D", "KEYCHAIN_TESTING", str(root / "native/keychain-helper/main.swift"), "-o", str(helper)], check=True, timeout=30)
    subprocess.run(["security", "create-keychain", "-p", "fixture-only", keychain], check=True, timeout=30)
    subprocess.run(["security", "unlock-keychain", "-p", "fixture-only", keychain], check=True, timeout=30)

    controller_path = pathlib.Path(folder) / "controller.json"
    controller = {"authorization": "a" * 64, "items": []}
    controller_path.write_text(json.dumps(controller))
    controller_path.chmod(0o600)
    pinned_ref = None

    def call(operation, **kwargs):
        payload = {"operation": operation, "service": "mitzo.connection.fixture", "account": "credential", "testKeychain": keychain, "testController": str(controller_path), "authorization": controller["authorization"], **({"persistentRef": pinned_ref} if pinned_ref and operation in ("read", "remove") else {}), **kwargs}
        result = subprocess.run([str(helper)], input=json.dumps(payload), text=True, capture_output=True, check=True, timeout=30)
        return json.loads(result.stdout)

    try:
        for namespace in ("../escape", "staging\n", "", "a" * 65, 123):
            assert call("save", secret="fixture-password", namespace=namespace)["code"] == "invalid_request"
        assert call("save", secret="fixture-password", authorization="wrong")["code"] == "unauthorized"
        saved = call("save", secret="fixture-password", namespace="staging")
        assert saved["ok"]
        pinned_ref = saved["persistentRef"]
        assert call("read")["code"] == "unauthorized", "unenrolled items are unavailable"
        controller["items"] = [{"service": "mitzo.connection.fixture", "account": "credential", "persistentRef": pinned_ref}]
        controller_path.write_text(json.dumps(controller))
        assert call("read")["secret"] == "fixture-password"
        isolated_controller = pathlib.Path(folder) / "isolated-controller.json"
        isolated_record = {"authorization": "b" * 64, "items": controller["items"]}
        isolated_controller.write_text(json.dumps(isolated_record))
        isolated_controller.chmod(0o600)
        assert call("read", namespace="isolated", testController=str(isolated_controller))["code"] == "unauthorized", "one controller capability cannot authenticate another namespace"
        assert call("read", namespace="isolated", testController=str(isolated_controller), authorization=isolated_record["authorization"])["code"] == "item_missing", "opaque credential pins are keyed to their controller capability"
        assert call("link", persistentRef=123)["code"] == "invalid_request", "malformed pinned identities must not fall back to coordinates"
        linked = call("link")
        assert linked["ok"] and "secret" not in linked
        assert call("save", secret="replacement")["code"] == "unavailable", "save must not overwrite an existing item"
        assert call("remove", service="another-app")["code"] == "invalid_request"
        assert call("list")["code"] == "invalid_request", "enumeration is unavailable"
        assert call("remove")["ok"]
        assert call("read")["code"] == "item_missing"
        replacement = call("save", secret="fixture-replacement")
        assert replacement["ok"]
        assert call("read")["code"] == "item_missing", "stale references must not resolve a replacement"
        assert call("remove")["ok"]
        assert call("link")["persistentRef"] == replacement["persistentRef"], "stale removal must preserve the replacement"
        pinned_ref = replacement["persistentRef"]
        controller["items"] = [{"service": "mitzo.connection.fixture", "account": "credential", "persistentRef": pinned_ref}]
        controller_path.write_text(json.dumps(controller))
        assert call("remove")["ok"]
        # Generated external fixture: linking must leave the original Keychain item untouched.
        external_service = "another-app.fixture"
        subprocess.run(["security", "add-generic-password", "-a", "credential", "-s", external_service, "-w", "external-fixture", "-A", keychain], check=True, capture_output=True, timeout=30)
        linked = call("link", service=external_service)
        assert linked["ok"]
        pinned_ref = linked["persistentRef"]
        controller["items"] = [{"service": external_service, "account": "credential", "persistentRef": pinned_ref}]
        controller_path.write_text(json.dumps(controller))
        assert call("read", service=external_service)["secret"] == "external-fixture"
        subprocess.run(["security", "add-generic-password", "-U", "-a", "credential", "-s", external_service, "-w", "changed-external-fixture", keychain], check=True, capture_output=True, timeout=30)
        assert call("read", service=external_service)["code"] == "item_missing", "linked credential changes require explicit re-enrollment"
        assert call("link", service=external_service)["persistentRef"] != pinned_ref
    finally:
        subprocess.run(["security", "delete-keychain", keychain], check=True, timeout=30)
print("Keychain helper: disposable-keychain checks passed")
