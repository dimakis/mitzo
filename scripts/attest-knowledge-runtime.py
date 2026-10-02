#!/usr/bin/env python3
"""Fingerprint installed compiler bytes and report the actual runtime target.

Run inside the built image for release metadata. Fingerprints-only mode exists
for offline verification and deliberately supplies no target marker attestation.
"""

import argparse
import base64
import hashlib
import json
import platform
import re
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def fingerprint(root, commit):
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"compiler contains a symlink: {path.relative_to(root)}")
        if path.is_file():
            files.append({"path": path.relative_to(root).as_posix(),
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        elif not path.is_dir():
            raise ValueError("compiler contains a special file")
    if not files:
        raise ValueError("installed compiler is empty")
    return hashlib.sha256(canonical({"commit": commit, "files": files})).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler-root", type=Path, default=Path("/usr/lib/contexgin"))
    parser.add_argument("--recipe", type=Path, default=Path("/sandbox/compile-mgmt-context.mjs"))
    parser.add_argument("--compiler-commit", required=True)
    parser.add_argument("--fingerprints-only", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.compiler_commit):
        parser.error("compiler commit must be a full lowercase SHA")
    if args.compiler_root.is_symlink() or args.recipe.is_symlink():
        parser.error("compiler and recipe must not be symlinks")
    result = {
        "knowledgeSchemaVersion": 1,
        "knowledgeCompilerCommit": args.compiler_commit,
        "knowledgeCompilerSha256": fingerprint(args.compiler_root, args.compiler_commit),
        "knowledgeRecipeSha256": hashlib.sha256(args.recipe.read_bytes()).hexdigest(),
    }
    if not args.fingerprints_only:
        if platform.system() != "Linux":
            parser.error("target attestation must run inside the Linux runtime image")
        from packaging.markers import default_environment
        architecture = {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
        if architecture is None:
            parser.error("unsupported runtime architecture")
        result["knowledgeTargetPlatform"] = f"linux/{architecture}"
        result["knowledgeTargetMarkerEnvironmentBase64"] = base64.b64encode(
            canonical(default_environment())
        ).decode()
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
