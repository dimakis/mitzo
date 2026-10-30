#!/usr/bin/env python3
"""Transfer compiled outputs within one CI candidate, never dependencies or caches."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import sys
import zipfile

ROOTS = {
    "server": ("dist", "packages/protocol/dist", "packages/harness/dist", "packages/client/dist"),
    "frontend": ("frontend/dist",),
}
REQUIRED = {
    "server": ("dist/index.js", "packages/protocol/dist/index.js", "packages/harness/dist/index.js", "packages/client/dist/index.js"),
    "frontend": ("frontend/dist/index.html",),
}
MAX_BYTES = 256 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_FILES = 25000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def identity(root):
    commit = git(root, "rev-parse", "HEAD")
    if commit != os.environ.get("GITHUB_SHA"):
        raise ValueError("Build checkout does not match the combined CI candidate")
    changed = git(root, "diff", "--name-only", "HEAD", "--").splitlines()
    if any(name != "package-lock.json" for name in changed):
        raise ValueError("Tracked build inputs changed after checkout")
    run = os.environ.get("GITHUB_RUN_ID", "")
    if not run.isdecimal():
        raise ValueError("Explicit workflow run identity required")
    node = subprocess.check_output(["node", "--version"], text=True).strip()
    return {
        "commit": commit,
        "tree": git(root, "rev-parse", "HEAD^{tree}"),
        "run": run,
        "platform": sys.platform,
        "machine": platform.machine(),
        "node": node,
        "installedLock": digest((root / "package-lock.json").read_bytes()),
    }


def scope_roots(scope):
    if scope not in ROOTS:
        raise ValueError("Explicit server or frontend output scope required")
    return ROOTS[scope]


def output_path(name, scope):
    path = PurePosixPath(name)
    if (not isinstance(name, str) or "\\" in name or path.is_absolute()
            or str(path) != name or any(part in (".", "..") for part in path.parts)
            or not any(name.startswith(prefix + "/") for prefix in scope_roots(scope))):
        raise ValueError("Unexpected compiled output path")
    return path


def regular_parent(root, path):
    for candidate in (path, *path.parents):
        if candidate == root:
            return
        if candidate.is_symlink():
            raise ValueError("Compiled outputs cannot traverse symbolic links")
        if candidate.exists() and not candidate.is_dir():
            raise ValueError("Compiled output parent is not a directory")
    raise ValueError("Compiled output escapes checkout")


def pack(root, scope, archive):
    roots = scope_roots(scope)
    source = identity(root)
    files = {}
    total = 0
    for prefix in roots:
        directory = root / prefix
        regular_parent(root, directory)
        if not directory.is_dir():
            raise ValueError("Required compiled output directory missing: " + prefix)
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError("Compiled output is a symbolic link")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError("Compiled output is not a regular file")
            name = path.relative_to(root).as_posix()
            output_path(name, scope)
            size = path.stat().st_size
            total += size
            if size > MAX_FILE or total > MAX_BYTES or len(files) >= MAX_FILES:
                raise ValueError("Compiled output exceeds bounded transfer size")
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode not in (0o644, 0o755):
                raise ValueError("Unexpected compiled output mode")
            files[name] = {"size": size, "sha256": digest(path.read_bytes()), "mode": mode}
    if not set(REQUIRED[scope]) <= files.keys():
        raise ValueError("Required compiled entry missing")
    manifest = {"schema": 2, "scope": scope, "identity": source, "files": files}
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest, sort_keys=True))
        for name in files:
            bundle.write(root / name, name)
    print(json.dumps({"files": len(files), "bytes": total, "candidate": source["commit"], "scope": scope}))


def restore(root, scope, archive):
    roots = scope_roots(scope)
    source = identity(root)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)) or len(names) > MAX_FILES + 1:
            raise ValueError("Duplicate or excessive compiled output entries")
        manifest_info = bundle.getinfo("manifest.json")
        if manifest_info.file_size > 8 * 1024 * 1024:
            raise ValueError("Oversized compiled output manifest")
        manifest = json.loads(bundle.read("manifest.json"))
        if (manifest.get("schema") != 2 or manifest.get("scope") != scope
                or manifest.get("identity") != source):
            raise ValueError("Compiled output scope, candidate, run, host or dependencies differ")
        files = manifest.get("files")
        if not isinstance(files, dict) or set(names) != {"manifest.json", *files} or not set(REQUIRED[scope]) <= files.keys():
            raise ValueError("Incomplete compiled output inventory")
        total = 0
        # Validate every byte and destination before replacing any build output.
        for name, expected in files.items():
            output_path(name, scope)
            info = bundle.getinfo(name)
            kind = stat.S_IFMT(info.external_attr >> 16)
            if kind not in (0, stat.S_IFREG) or info.is_dir():
                raise ValueError("Compiled output archive contains a non-regular file")
            total += info.file_size
            if info.file_size > MAX_FILE or total > MAX_BYTES:
                raise ValueError("Compiled output exceeds bounded transfer size")
            if (expected.get("size") != info.file_size
                    or expected.get("mode") not in (0o644, 0o755)
                    or digest(bundle.read(name)) != expected.get("sha256")):
                raise ValueError("Compiled output content or mode differs")
            regular_parent(root, (root / name).parent)
        for prefix in roots:
            path = root / prefix
            regular_parent(root, path)
        for prefix in roots:
            shutil.rmtree(root / prefix, ignore_errors=False) if (root / prefix).exists() else None
        for name, expected in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bundle.read(name))
            path.chmod(expected["mode"])
    print(json.dumps({"restoredFiles": len(files), "bytes": total, "candidate": source["commit"], "scope": scope}))


if __name__ == "__main__":
    if (len(sys.argv) != 4 or sys.argv[1] not in ("pack", "restore")
            or sys.argv[2] not in ROOTS):
        raise SystemExit("Usage: ci-build-output.py pack|restore server|frontend ARCHIVE")
    {"pack": pack, "restore": restore}[sys.argv[1]](Path.cwd().resolve(), sys.argv[2], Path(sys.argv[3]))
