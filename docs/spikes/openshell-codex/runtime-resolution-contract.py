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
try:
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
    from packaging.specifiers import SpecifierSet
except ModuleNotFoundError:  # Python's pip vendors the standards parser.
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.specifiers import SpecifierSet


def normalized_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def canonical_json(value):
    """Compact UTF-8 JSON with object keys ordered by their UTF-8 bytes.

    Node's locale-aware ordering and Python's default ASCII escaping both
    diverge for non-ASCII paths.  The release publisher and runtime verifier
    use this explicit representation for cross-language digest contracts.
    """
    return json.dumps(canonical_json_value(value), ensure_ascii=False, separators=(",", ":"))


def canonical_json_value(value):
    if isinstance(value, dict):
        return {
            key: canonical_json_value(value[key])
            for key in sorted(value, key=lambda key: key.encode("utf-8"))
        }
    if isinstance(value, list):
        return [canonical_json_value(entry) for entry in value]
    return value


def target_environment(target_platform):
    operating_system, architecture = target_platform.split("/", 1)
    return {
        **default_environment(),
        "sys_platform": operating_system,
        "platform_system": {"linux": "Linux", "darwin": "Darwin", "win32": "Windows"}.get(operating_system, operating_system),
        "platform_machine": {"amd64": "x86_64", "arm64": "aarch64"}.get(architecture, architecture),
    }
def parse_pep508_requirement(requirement, target_platform):
    """Extract a lock edge from a complete PEP 508 requirement.

    Use packaging's standards parser (or pip's vendored identical parser) so
    grouping, extras, direct references, and PEP 440 specifiers retain uv's
    own accepted semantics.
    """
    if not isinstance(requirement, str):
        raise SystemExit("unsupported dependency-group requirement")
    try:
        parsed = Requirement(requirement)
    except Exception as error:
        raise SystemExit("unsupported dependency-group requirement") from error
    if parsed.marker and not parsed.marker.evaluate(target_environment(target_platform)):
        return None
    return {"name": normalized_name(parsed.name), **({"specifier": str(parsed.specifier)} if parsed.specifier else {})}


def dependencies(value, target_platform):
    result = []
    for dependency in value or []:
        if isinstance(dependency, str):
            edge = parse_pep508_requirement(dependency, target_platform)
            if edge:
                result.append(edge)
        elif isinstance(dependency, dict) and isinstance(dependency.get("name"), str):
            marker = dependency.get("marker")
            if not marker or Requirement(f"placeholder; {marker}").marker.evaluate(target_environment(target_platform)):
                result.append({
                    key: value
                    for key, value in dependency.items()
                    if key != "marker"
                } | {"name": normalized_name(dependency["name"]), **({"specifier": f"=={dependency['version']}"} if 'version' in dependency else {})})
        else:
            raise SystemExit("unsupported uv.lock dependency entry")
    return result


def qualified_candidates(by_name, edge):
    candidates = by_name.get(edge["name"], [])
    if edge.get("specifier"):
        candidates = [candidate for candidate in candidates if isinstance(candidate.get("version"), str) and SpecifierSet(edge["specifier"]).contains(candidate["version"], prereleases=True)]
    if "source" in edge:
        candidates = [candidate for candidate in candidates if candidate.get("source") == edge["source"]]
    if not candidates:
        raise SystemExit(f"uv.lock is missing selected dependency {edge['name']}")
    if len(candidates) != 1:
        raise SystemExit(f"uv.lock dependency {edge['name']} is not qualified to one selected package")
    return candidates[0]


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
    def expand_group(group, stack=()):
        if group in stack:
            raise SystemExit(f"dependency-group include cycle: {' -> '.join((*stack, group))}")
        values = dependency_groups.get(group)
        if not isinstance(values, list):
            raise SystemExit(f"selected dependency group is missing or malformed: {group}")
        expanded = []
        for value in values:
            if isinstance(value, dict) and set(value) == {"include-group"} and isinstance(value["include-group"], str):
                expanded.extend(expand_group(value["include-group"], (*stack, group)))
            elif isinstance(value, str):
                expanded.append(value)
            else:
                raise SystemExit("unsupported dependency-group requirement")
        return expanded
    selected_groups = {group: expand_group(group) for group in sorted(default_groups) if group != "dev"}

    # uv sync --no-dev starts at the root's ordinary dependencies.  Do not
    # traverse dependency-groups/dev-dependencies, but retain each selected
    # package verbatim so markers, sources, URLs and wheels stay meaningful.
    selected_names = {canonical_json({
        key: roots[0][key] for key in ("name", "version", "source") if key in roots[0]
    })}
    pending = dependencies(roots[0].get("dependencies"), args.target_platform)
    # `uv sync --no-dev` still installs explicitly selected non-dev default
    # groups. Include their full lock closures, not just their names in
    # metadata, so a source/version/artifact change cannot evade the contract.
    for values in selected_groups.values():
        pending.extend(dependencies(values, args.target_platform))
    while pending:
        edge = pending.pop()
        package = qualified_candidates(by_name, edge)
        name = normalized_name(package["name"])
        package_identity = canonical_json({
            key: package[key] for key in ("name", "version", "source") if key in package
        })
        if package_identity in selected_names:
            continue
        selected_names.add(package_identity)
        pending.extend(dependencies(package.get("dependencies"), args.target_platform))
    selected = []
    for package in packages:
        package_identity = canonical_json({
            key: package[key] for key in ("name", "version", "source") if key in package
        })
        if package_identity in selected_names:
            name = normalized_name(package["name"])
            # The root's version, dev-dependencies and build metadata are not
            # installed by `uv sync --no-dev --no-install-project`.  Keeping
            # them in the image contract makes a dev-only edit spuriously
            # require an image migration.  Retain only root fields that affect
            # the resolved runtime closure.
            if name == root_name:
                root_dependencies = [
                    dependency
                    for dependency in package.get("dependencies", [])
                    if not isinstance(dependency, dict)
                    or not dependency.get("marker")
                    or Requirement(f"placeholder; {dependency['marker']}").marker.evaluate(target_environment(args.target_platform))
                ]
                selected.append(
                    {
                        key: (root_dependencies if key == "dependencies" else package[key])
                        for key in ("name", "source", "dependencies", "requires-python")
                        if key in package
                    }
                )
            else:
                selected.append(package)
    selected.sort(key=canonical_json)
    runtime_dependencies = project.get("dependencies", [])
    if not isinstance(runtime_dependencies, list) or not all(
        isinstance(dependency, str) for dependency in runtime_dependencies
    ):
        raise SystemExit("pyproject.toml project.dependencies is malformed")
    runtime_uv = {
        key: value
        for key, value in uv_config.items()
        if key not in {"default-groups", "dev-dependencies", "sources"}
    }
    sources = uv_config.get("sources", {})
    if not isinstance(sources, dict):
        raise SystemExit("pyproject.toml tool.uv.sources is malformed")
    runtime_sources = {
        name: value
        for name, value in sources.items()
        if isinstance(name, str) and any(
            normalized_name(package["name"]) == normalized_name(name)
            and canonical_json({
                key: package[key] for key in ("name", "version", "source") if key in package
            }) in selected_names
            for package in packages
        )
    }
    contract = {
        "schemaVersion": 1,
        "install": {"command": "uv sync --frozen --no-dev --no-install-project"},
        "target": {"baseImage": args.base_image, "platform": args.target_platform},
        "project": {
            "name": root_name,
            "requiresPython": project["requires-python"],
            "dependencies": runtime_dependencies,
            "defaultGroups": sorted(group for group in default_groups if group != "dev"),
            "selectedDependencyGroups": selected_groups,
            "uv": runtime_uv,
            "sources": runtime_sources,
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
    payload = canonical_json(contract) + "\n"
    if args.output:
        Path(args.output).write_text(payload, encoding="utf-8")
    if args.sha256:
        print(hashlib.sha256(payload.encode("utf-8")).hexdigest())
    elif not args.output:
        print(payload, end="")


if __name__ == "__main__":
    main()
