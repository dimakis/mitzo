#!/usr/bin/env python3
"""Transfer compiled outputs within one CI candidate, never dependencies or caches."""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import zipfile

ROOTS = {
    "server": ("dist", "packages/protocol/dist", "packages/harness/dist", "packages/client/dist"),
    "frontend": ("frontend/dist",),
    "workspace": ("packages/protocol/dist", "packages/harness/dist", "packages/client/dist"),
    "ios-web": ("frontend/dist-ios",),
}
REQUIRED = {
    "server": ("dist/index.js", "packages/protocol/dist/index.js", "packages/harness/dist/index.js", "packages/client/dist/index.js"),
    "frontend": ("frontend/dist/index.html",),
    "workspace": ("packages/protocol/dist/index.js", "packages/harness/dist/index.js", "packages/client/dist/index.js"),
    "ios-web": ("frontend/dist-ios/index.html",),
}
PORTABLE = {"workspace": "generated-workspace-v1", "ios-web": "vite-ios-web-v1"}
MAX_BYTES = 256 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_FILES = 25000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def require_portable_dependencies(locked, installed):
    """Permit only exact platform variants directly declared by locked parents."""
    for name, expected in locked.items():
        actual = installed.get(name)
        if actual is None and expected.get("optional"):
            continue
        if actual is None or any(actual.get(key) != expected.get(key) for key in ("version", "resolved", "integrity", "link")):
            raise ValueError("Portable build dependencies differ from the source lock")
    allowed = {}
    for parent, expected in locked.items():
        if parent not in installed:
            continue
        for dependency, version in expected.get("optionalDependencies", {}).items():
            if (not re.fullmatch(r"(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+", dependency)
                    or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version)):
                continue
            # Follow Node's nearest installed slot, including scoped packages
            # and hoisted dependencies. A hidden duplicate is not that edge.
            owner = parent
            for _ in range(parent.count("node_modules") + 2):
                target = (owner + "/" if owner else "") + "node_modules/" + dependency
                if target in installed:
                    allowed.setdefault(target, set()).add(version)
                    break
                if not owner:
                    break
                owner = owner.rsplit("/node_modules/", 1)[0] if "/node_modules/" in owner else ""
    for name, value in installed.items():
        if name in locked:
            continue
        constraints = [value.get(field) for field in ("os", "cpu")]
        if (value.get("optional") is not True or value.get("version") not in allowed.get(name, set())
                or any(not isinstance(values, list) or not 1 <= len(values) <= 32
                       or any(not isinstance(item, str) or item == "any"
                              or not re.fullmatch(r"[a-z0-9_-]+", item) for item in values)
                       for values in constraints)):
            raise ValueError("Portable build has an unproven platform dependency")


def portable_lock(root):
    # Bind source resolutions, not arbitrary optional metadata introduced by
    # npm. Unpinned ranges and installed-only parent chains require a reviewed
    # source lock update; source-only edges cannot pin absent tarball integrity.
    committed = subprocess.check_output(["git", "show", "HEAD:package-lock.json"], cwd=root)
    locked = json.loads(committed)["packages"]
    installed = json.loads((root / "package-lock.json").read_bytes())["packages"]
    require_portable_dependencies(locked, installed)
    compiler = json.loads((root / "node_modules/typescript/package.json").read_bytes())["version"]
    if compiler != locked["node_modules/typescript"]["version"]:
        raise ValueError("Portable compiler differs from the source lock")
    return {"sourceLock": digest(committed), "compiler": compiler}


def identity(root, scope=None):
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
    source = {
        "commit": commit,
        "tree": git(root, "rev-parse", "HEAD^{tree}"),
        "run": run,
        "platform": sys.platform,
        "machine": platform.machine(),
        "node": node,
        "installedLock": digest((root / "package-lock.json").read_bytes()),
    }
    if scope in PORTABLE:
        # These explicit scopes contain generated code/assets only. Dependencies,
        # native tools and existing server/frontend transfers stay host-bound.
        del source["platform"]
        del source["machine"]
        del source["installedLock"]
        source.update(portable_lock(root))
        source["portableOutput"] = PORTABLE[scope]
    return source


def scope_roots(scope):
    if scope not in ROOTS:
        raise ValueError("Explicit known compiled output scope required")
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


def portable_output(name, data, mode, scope):
    if scope not in PORTABLE:
        return
    extensions = ((".js", ".d.ts", ".json", ".map") if scope == "workspace" else
                  (".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".png", ".jpg",
                   ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".txt", ".webmanifest"))
    # pdf-assets-plugin.ts retains these dependency-owned web resources. WASM
    # here is browser code; it must never broaden workspace/native transfers.
    pdf_asset = scope == "ios-web" and bool(re.fullmatch(
        r"frontend/dist-ios/pdfjs/(?:cmaps/[A-Za-z0-9_.-]+\.bcmap|standard_fonts/[A-Za-z0-9_.-]+\.(?:pfb|ttf)|wasm/[A-Za-z0-9_.-]+\.(?:wasm|js)|(?:cmaps|standard_fonts|wasm)/LICENSE(?:_[A-Z0-9_]+)?)", name))
    native_magic = (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
                    b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca", b"MZ")
    if (mode != 0o644 or (not name.endswith(extensions) and not pdf_asset) or data.startswith(native_magic)
            or (data.startswith(b"\0asm") and not (pdf_asset and name.endswith(".wasm")))):
        raise ValueError("Portable output cannot contain native or executable files")
    if scope == "workspace":
        if "\0" in data.decode("utf8"):
            raise ValueError("Workspace outputs must be generated text")


def pack(root, scope, archive):
    roots = scope_roots(scope)
    source = identity(root, scope)
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
            data = path.read_bytes()
            portable_output(name, data, mode, scope)
            files[name] = {"size": size, "sha256": digest(data), "mode": mode}
    if not set(REQUIRED[scope]) <= files.keys():
        raise ValueError("Required compiled entry missing")
    manifest = {"schema": 2, "scope": scope, "identity": source, "files": files}
    if scope in PORTABLE:
        manifest["producer"] = identity(root)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest, sort_keys=True))
        for name in files:
            bundle.write(root / name, name)
    print(json.dumps({"files": len(files), "bytes": total, "candidate": source["commit"], "scope": scope}))


def restore(root, scope, archive):
    roots = scope_roots(scope)
    source = identity(root, scope)
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
        if scope in PORTABLE:
            producer = manifest.get("producer")
            if (not isinstance(producer, dict)
                    or set(producer) != {"commit", "tree", "run", "platform", "machine", "node", "installedLock"}
                    or any(producer[key] != source[key] for key in ("commit", "tree", "run", "node"))
                    or producer["platform"] not in ("linux", "darwin")
                    or not isinstance(producer["machine"], str)
                    or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", producer["machine"])
                    or not isinstance(producer["installedLock"], str)
                    or not re.fullmatch(r"[a-f0-9]{64}", producer["installedLock"])):
                raise ValueError("Portable producer provenance unavailable")
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
            data = bundle.read(name)
            if (expected.get("size") != info.file_size
                    or expected.get("mode") not in (0o644, 0o755)
                    or digest(data) != expected.get("sha256")):
                raise ValueError("Compiled output content or mode differs")
            portable_output(name, data, expected["mode"], scope)
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
        raise SystemExit("Usage: ci-build-output.py pack|restore server|frontend|workspace|ios-web ARCHIVE")
    {"pack": pack, "restore": restore}[sys.argv[1]](Path.cwd().resolve(), sys.argv[2], Path(sys.argv[3]))
