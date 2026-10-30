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
        for name in transfer.REQUIRED:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("compiled " + name)
            path.chmod(0o644)
        transfer.pack(self.root, self.archive)

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
        entry = self.root / "dist/index.js"
        entry.write_text("leave existing output intact on rejection")
        with self.assertRaises((ValueError, KeyError, zipfile.BadZipFile)):
            transfer.restore(self.root, self.archive)
        self.assertEqual(entry.read_text(), "leave existing output intact on rejection")

    def test_restores_exact_outputs_and_removes_stale_files(self):
        stale = self.root / "dist/stale.js"
        stale.write_text("stale")
        transfer.restore(self.root, self.archive)
        self.assertFalse(stale.exists())
        for name in transfer.REQUIRED:
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
                transfer.pack(self.root, self.archive)
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
                transfer.pack(self.root, self.archive)
                def change(entries):
                    name = "dist/index.js"
                    info, data = entries[name]
                    if kind == "missing":
                        del entries[name]
                    elif kind == "extra":
                        extra = zipfile.ZipInfo("dist/extra.js")
                        entries[extra.filename] = (extra, b"extra")
                    elif kind == "corrupt":
                        entries[name] = (info, b"changed")
                    else:
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                        entries[name] = (info, data)
                self.rewrite(change)
                self.rejected()
        transfer.pack(self.root, self.archive)
        with zipfile.ZipFile(self.archive, "a") as archive:
            archive.writestr("dist/index.js", "duplicate")
        self.rejected()

    def test_rejects_manifest_traversal_even_with_matching_digest(self):
        for name in ("../escaped.js", "/tmp/escaped.js", "dist/../escaped.js", "dist\\escaped.js", "node_modules/escape.js"):
            with self.subTest(name=name):
                transfer.pack(self.root, self.archive)
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
        transfer.shutil.rmtree(self.root / "packages/client/dist")
        (self.root / "packages/client/dist").symlink_to(outside, target_is_directory=True)
        self.rejected()
        self.assertEqual(list(outside.iterdir()), [])

    def test_pack_rejects_incomplete_and_linked_output_and_restore_bounds_size(self):
        entry = self.root / "dist/index.js"
        entry.unlink()
        with self.assertRaises(ValueError):
            transfer.pack(self.root, self.archive)
        entry.symlink_to(self.root / "source.ts")
        with self.assertRaises(ValueError):
            transfer.pack(self.root, self.archive)
        entry.unlink()
        entry.write_text("compiled")
        transfer.pack(self.root, self.archive)
        with patch.object(transfer, "MAX_BYTES", 1):
            self.rejected()


if __name__ == "__main__":
    unittest.main()
