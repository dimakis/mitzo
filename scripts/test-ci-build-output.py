#!/usr/bin/env python3
"""Offline rejection tests for the actual candidate-bound build transfer."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("ci_build_output", Path(__file__).with_name("ci-build-output.py"))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class BuildOutputTests(unittest.TestCase):
    scope = "server"
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "compiled.zip"
        self.git("init", "-q")
        (self.root / "package-lock.json").write_text('{"dependencies": {}}\n')
        (self.root / "source.ts").write_text("export const value = 1;\n")
        self.git("add", "package-lock.json", "source.ts")
        self.git("-c", "user.name=CI Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        self.environment = patch.dict(os.environ, {"GITHUB_SHA": self.git("rev-parse", "HEAD"), "GITHUB_RUN_ID": "123"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        for name in (name for required in transfer.REQUIRED.values() for name in required):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("compiled " + name)
            path.chmod(0o644)
        transfer.pack(self.root, self.scope, self.archive)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True).strip()

    def rewrite(self, change):
        with zipfile.ZipFile(self.archive) as archive:
            entries = {entry.filename: (entry, archive.read(entry)) for entry in archive.infolist()}
        change(entries)
        with zipfile.ZipFile(self.archive, "w") as archive:
            for info, data in entries.values():
                archive.writestr(info, data)

    def rejected(self):
        entry = self.root / transfer.REQUIRED[self.scope][0]
        entry.write_text("leave existing output intact on rejection")
        with self.assertRaises((ValueError, KeyError, zipfile.BadZipFile)):
            transfer.restore(self.root, self.scope, self.archive)
        self.assertEqual(entry.read_text(), "leave existing output intact on rejection")

    def test_restores_exact_outputs_and_removes_stale_files(self):
        stale = self.root / (transfer.ROOTS[self.scope][0] + "/stale.js")
        stale.write_text("stale")
        transfer.restore(self.root, self.scope, self.archive)
        self.assertFalse(stale.exists())
        for name in transfer.REQUIRED[self.scope]:
            self.assertEqual((self.root / name).read_text(), "compiled " + name)

    def test_rejects_different_candidate_run_dependencies_and_source(self):
        for variable in ("GITHUB_SHA", "GITHUB_RUN_ID"):
            with self.subTest(variable=variable), patch.dict(os.environ, {variable: "456"}):
                self.rejected()
        lock = self.root / "package-lock.json"
        original = lock.read_text()
        lock.write_text("different resolved dependencies")
        self.rejected()
        lock.write_text(original)
        (self.root / "source.ts").write_text("changed source")
        self.rejected()

    def test_rejects_host_or_node_drift(self):
        for field in ("platform", "machine", "node", "tree"):
            with self.subTest(field=field):
                transfer.pack(self.root, self.scope, self.archive)
                def change(entries):
                    info, data = entries["manifest.json"]
                    manifest = json.loads(data)
                    manifest["identity"][field] = "different"
                    entries["manifest.json"] = (info, json.dumps(manifest).encode())
                self.rewrite(change)
                self.rejected()

    def test_rejects_missing_extra_corrupt_duplicate_and_symlink_entries(self):
        for kind in ("missing", "extra", "corrupt", "symlink"):
            with self.subTest(kind=kind):
                transfer.pack(self.root, self.scope, self.archive)
                def change(entries):
                    name = transfer.REQUIRED[self.scope][0]
                    info, data = entries[name]
                    if kind == "missing":
                        del entries[name]
                    elif kind == "extra":
                        extra = zipfile.ZipInfo(transfer.ROOTS[self.scope][0] + "/extra.js")
                        entries[extra.filename] = (extra, b"extra")
                    elif kind == "corrupt":
                        entries[name] = (info, b"changed")
                    else:
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                        entries[name] = (info, data)
                self.rewrite(change)
                self.rejected()
        transfer.pack(self.root, self.scope, self.archive)
        with zipfile.ZipFile(self.archive, "a") as archive:
            archive.writestr(transfer.REQUIRED[self.scope][0], "duplicate")
        self.rejected()

    def test_rejects_manifest_traversal_even_with_matching_digest(self):
        for name in ("../escaped.js", "/tmp/escaped.js", "dist/../escaped.js", "dist\\escaped.js", "node_modules/escape.js",
                     "frontend/dist/extra.js" if self.scope == "server" else "dist/extra.js"):
            with self.subTest(name=name):
                transfer.pack(self.root, self.scope, self.archive)
                def change(entries):
                    info, data = entries["manifest.json"]
                    manifest = json.loads(data)
                    manifest["files"][name] = {"size": 1, "sha256": transfer.digest(b"x"), "mode": 0o644}
                    entries["manifest.json"] = (info, json.dumps(manifest).encode())
                    extra = zipfile.ZipInfo(name)
                    entries[name] = (extra, b"x")
                self.rewrite(change)
                self.rejected()

    def test_rejects_existing_symlink_parent_without_touching_target(self):
        outside = self.root / "outside"
        outside.mkdir()
        # The selected archive contains this destination; a consumer must never
        # follow a pre-existing link while restoring either independent scope.
        nested = self.root / transfer.ROOTS[self.scope][0] / "nested"
        nested.mkdir()
        (nested / "value.js").write_text("nested output")
        transfer.pack(self.root, self.scope, self.archive)
        transfer.shutil.rmtree(nested)
        nested.symlink_to(outside, target_is_directory=True)
        self.rejected()
        self.assertEqual(list(outside.iterdir()), [])

    def test_rejects_existing_output_root_symlink_without_touching_target(self):
        outside = self.root / "outside-root"
        outside.mkdir()
        # Keep the prior packages/client/dist root rejection as well as testing
        # the independently restored frontend root and nested-parent rejection.
        target = self.root / transfer.ROOTS[self.scope][-1]
        transfer.shutil.rmtree(target)
        target.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            transfer.restore(self.root, self.scope, self.archive)
        self.assertEqual(list(outside.iterdir()), [])

    def test_pack_rejects_incomplete_and_linked_output_and_restore_bounds_size(self):
        entry = self.root / transfer.REQUIRED[self.scope][0]
        entry.unlink()
        with self.assertRaises(ValueError):
            transfer.pack(self.root, self.scope, self.archive)
        entry.symlink_to(self.root / "source.ts")
        with self.assertRaises(ValueError):
            transfer.pack(self.root, self.scope, self.archive)
        entry.unlink()
        entry.write_text("compiled")
        transfer.pack(self.root, self.scope, self.archive)
        with patch.object(transfer, "MAX_BYTES", 1):
            self.rejected()

    def test_manifest_scope_cannot_select_or_replace_another_output_owner(self):
        other = "frontend" if self.scope == "server" else "server"
        entry = self.root / transfer.REQUIRED[other][0]
        entry.write_text("preserve the other scope")
        with self.assertRaises(ValueError):
            transfer.restore(self.root, other, self.archive)
        self.assertEqual(entry.read_text(), "preserve the other scope")
        def change(entries):
            info, data = entries["manifest.json"]
            manifest = json.loads(data)
            manifest["scope"] = other
            entries["manifest.json"] = (info, json.dumps(manifest).encode())
        self.rewrite(change)
        self.rejected()
        self.assertEqual(entry.read_text(), "preserve the other scope")

    def test_restore_replaces_only_its_explicit_output_scope(self):
        other = "frontend" if self.scope == "server" else "server"
        existing = self.root / transfer.REQUIRED[other][0]
        existing.write_text("independently restored output")
        stale_other = self.root / transfer.ROOTS[other][0] / "keep.js"
        stale_other.write_text("other scope is untouched")
        transfer.restore(self.root, self.scope, self.archive)
        self.assertEqual(existing.read_text(), "independently restored output")
        self.assertEqual(stale_other.read_text(), "other scope is untouched")
        with zipfile.ZipFile(self.archive) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["scope"], self.scope)
        self.assertTrue(all(any(name.startswith(root + "/") for root in transfer.ROOTS[self.scope])
                            for name in manifest["files"]))

    def test_pack_and_restore_do_not_require_the_other_producer_outputs(self):
        other = "frontend" if self.scope == "server" else "server"
        for prefix in transfer.ROOTS[other]:
            transfer.shutil.rmtree(self.root / prefix)
        transfer.pack(self.root, self.scope, self.archive)
        transfer.restore(self.root, self.scope, self.archive)
        for prefix in transfer.ROOTS[other]:
            self.assertFalse((self.root / prefix).exists())

    def test_requires_an_explicit_known_scope_for_pack_and_restore(self):
        for scope in ("", "all", "../server", None):
            with self.subTest(scope=scope):
                with self.assertRaises(ValueError):
                    transfer.pack(self.root, scope, self.archive)
                with self.assertRaises(ValueError):
                    transfer.restore(self.root, scope, self.archive)


class FrontendBuildOutputTests(BuildOutputTests):
    scope = "frontend"


if __name__ == "__main__":
    unittest.main()
