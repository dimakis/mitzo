#!/usr/bin/env python3
"""Produce the immutable no-dev runtime resolution contract.

This is deliberately a lock-file projection, not a host re-resolution.  The
same bytes are produced while building an image, when preparing a descendant
seed, and are embedded in the image for production preflight to inspect.
"""
import argparse
import hashlib
import json
import re
import tomllib
from pathlib import Path


def normalized_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def dependency_names(value):
    result = []
    for dependency in value or []:
        if isinstance(dependency, str):
            match = re.match(r"[A-Za-z0-9_.-]+", dependency)
            if not match:
                raise SystemExit("unsupported dependency-group requirement")
            result.append(normalized_name(match.group(0)))
        elif isinstance(dependency, dict) and isinstance(dependency.get("name"), str):
            result.append(normalized_name(dependency["name"]))
        else:
            raise SystemExit("unsupported uv.lock dependency entry")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pyproject", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--base-image", required=True)
    parser.add_argument("--target-platform", required=True)
    parser.add_argument("--output")
    parser.add_argument("--sha256", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", args.base_image):
        raise SystemExit("resolution contract requires a digest-pinned base image")
    if not re.fullmatch(r"[a-z0-9]+/[a-z0-9][a-z0-9._-]*", args.target_platform):
        raise SystemExit("resolution contract requires an explicit target platform")

    with Path(args.pyproject).open("rb") as handle:
        project = tomllib.load(handle).get("project")
    with Path(args.lock).open("rb") as handle:
        lock = tomllib.load(handle)
    if not isinstance(project, dict) or not isinstance(project.get("name"), str):
        raise SystemExit("pyproject.toml must define project.name")
    if not isinstance(project.get("requires-python"), str):
        raise SystemExit("pyproject.toml must define project.requires-python")
    packages = lock.get("package")
    if not isinstance(packages, list):
        raise SystemExit("uv.lock has no package array")

    by_name = {}
    for package in packages:
        if not isinstance(package, dict) or not isinstance(package.get("name"), str):
            raise SystemExit("uv.lock package is malformed")
        by_name.setdefault(normalized_name(package["name"]), []).append(package)
    root_name = normalized_name(project["name"])
    roots = by_name.get(root_name, [])
    if len(roots) != 1:
        raise SystemExit("uv.lock must contain exactly one root project package")
    pyproject = tomllib.loads(Path(args.pyproject).read_text())
    uv_config = pyproject.get("tool", {}).get("uv", {})
    if not isinstance(uv_config, dict):
        raise SystemExit("pyproject.toml tool.uv is malformed")
    default_groups = uv_config.get("default-groups", ["dev"])
    if not isinstance(default_groups, list) or not all(isinstance(group, str) for group in default_groups):
        raise SystemExit("pyproject.toml tool.uv.default-groups is malformed")
    dependency_groups = pyproject.get("dependency-groups", {})
    if not isinstance(dependency_groups, dict):
        raise SystemExit("pyproject.toml dependency-groups is malformed")
    selected_groups = {group: dependency_groups.get(group, []) for group in sorted(default_groups) if group != "dev"}
    if not all(isinstance(values, list) for values in selected_groups.values()):
        raise SystemExit("selected dependency group is malformed")

    # uv sync --no-dev starts at the root's ordinary dependencies.  Do not
    # traverse dependency-groups/dev-dependencies, but retain each selected
    # package verbatim so markers, sources, URLs and wheels stay meaningful.
    selected_names = {root_name}
    pending = dependency_names(roots[0].get("dependencies"))
    # `uv sync --no-dev` still installs explicitly selected non-dev default
    # groups. Include their full lock closures, not just their names in
    # metadata, so a source/version/artifact change cannot evade the contract.
    for values in selected_groups.values():
        pending.extend(dependency_names(values))
    while pending:
        name = pending.pop()
        if name in selected_names:
            continue
        candidates = by_name.get(name)
        if not candidates:
            raise SystemExit(f"uv.lock is missing selected dependency {name}")
        selected_names.add(name)
        for candidate in candidates:
            pending.extend(dependency_names(candidate.get("dependencies")))
    selected = []
    for name in sorted(selected_names):
        selected.extend(by_name[name])
    selected.sort(key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))
    contract = {
        "schemaVersion": 1,
        "install": {"command": "uv sync --frozen --no-dev --no-install-project"},
        "target": {"baseImage": args.base_image, "platform": args.target_platform},
        "project": {
            "name": root_name,
            "requiresPython": project["requires-python"],
            "defaultGroups": sorted(default_groups),
            "selectedDependencyGroups": selected_groups,
        },
        "lock": {
            "version": lock.get("version"),
            "revision": lock.get("revision"),
            "requiresPython": lock.get("requires-python"),
            "resolutionMarkers": lock.get("resolution-markers", []),
            "options": lock.get("options", {}),
            "packages": selected,
        },
    }
    payload = json.dumps(contract, sort_keys=True, separators=(",", ":")) + "\n"
    if args.output:
        Path(args.output).write_text(payload)
    if args.sha256:
        print(hashlib.sha256(payload.encode()).hexdigest())
    elif not args.output:
        print(payload, end="")


if __name__ == "__main__":
    main()
