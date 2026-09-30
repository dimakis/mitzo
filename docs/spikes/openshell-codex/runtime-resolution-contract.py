#!/usr/bin/env python3
"""Produce the immutable no-dev runtime resolution contract.

This is deliberately a lock-file projection, not a host re-resolution.  The
same bytes are produced while building an image, when preparing a descendant
seed, and are embedded in the image for production preflight to inspect.
"""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
try:
    from packaging.requirements import Requirement
    from packaging.specifiers import SpecifierSet
except ModuleNotFoundError:  # Python's pip vendors the standards parser.
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


MARKER_ENVIRONMENT_KEYS = {
    "implementation_name", "implementation_version", "os_name",
    "platform_machine", "platform_release", "platform_system",
    "platform_version", "platform_python_implementation", "python_full_version",
    "python_version", "sys_platform",
}


def target_environment(encoded_environment, target_platform, extra=""):
    """Use the marker environment observed in the pinned runtime image.

    The image is the only authority for Python-version and implementation
    markers.  Never fill omitted fields from the host running this helper.
    """
    try:
        environment = json.loads(base64.b64decode(encoded_environment, validate=True))
    except Exception as error:
        raise SystemExit("resolution contract requires a valid target marker environment") from error
    if not isinstance(environment, dict) or set(environment) != MARKER_ENVIRONMENT_KEYS or not all(
        isinstance(value, str) for value in environment.values()
    ):
        raise SystemExit("resolution contract requires a complete target marker environment")
    operating_system, architecture = target_platform.split("/", 1)
    expected_system = {"linux": "Linux", "darwin": "Darwin", "win32": "Windows"}.get(operating_system, operating_system)
    expected_machine = {"amd64": "x86_64", "arm64": "aarch64"}.get(architecture, architecture)
    expected_os_name = "nt" if operating_system == "win32" else "posix"
    if environment["sys_platform"] != operating_system or environment["os_name"] != expected_os_name or environment["platform_system"] != expected_system or environment["platform_machine"] != expected_machine:
        raise SystemExit("target marker environment does not match target platform")
    return environment | {"extra": extra}


def parse_pep508_requirement(requirement, marker_environment):
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
    if parsed.marker and not parsed.marker.evaluate(marker_environment):
        return None
    return {
        "name": normalized_name(parsed.name),
        **({"specifier": str(parsed.specifier)} if parsed.specifier else {}),
        **({"extras": sorted(parsed.extras)} if parsed.extras else {}),
    }


def dependencies(value, marker_environment):
    result = []
    for dependency in value or []:
        if isinstance(dependency, str):
            edge = parse_pep508_requirement(dependency, marker_environment)
            if edge:
                result.append(edge)
        elif isinstance(dependency, dict) and isinstance(dependency.get("name"), str):
            marker = dependency.get("marker")
            if not marker or Requirement(f"placeholder; {marker}").marker.evaluate(marker_environment):
                extras = dependency.get("extras", dependency.get("extra", []))
                if isinstance(extras, str):
                    extras = [extras]
                if not isinstance(extras, list) or not all(isinstance(extra, str) for extra in extras):
                    raise SystemExit("unsupported uv.lock dependency extras")
                result.append({
                    key: value
                    for key, value in dependency.items()
                    if key != "marker"
                } | {"name": normalized_name(dependency["name"]), **({"specifier": f"=={dependency['version']}"} if 'version' in dependency else {}), **({"extras": sorted(extras)} if extras else {})})
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
    parser.add_argument("--target-marker-environment-b64", required=True)
    parser.add_argument("--output")
    parser.add_argument("--sha256", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", args.base_image):
        raise SystemExit("resolution contract requires a digest-pinned base image")
    if not re.fullmatch(r"[a-z0-9]+/[a-z0-9][a-z0-9._-]*", args.target_platform):
        raise SystemExit("resolution contract requires an explicit target platform")
    marker_environment = target_environment(args.target_marker_environment_b64, args.target_platform)

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
    locked_dependency_groups = roots[0].get("dev-dependencies", {})
    if not isinstance(locked_dependency_groups, dict):
        raise SystemExit("uv.lock root dependency groups are malformed")

    # uv sync --no-dev starts at the root's ordinary dependencies.  Do not
    # traverse dependency-groups/dev-dependencies, but retain each selected
    # package verbatim so markers, sources, URLs and wheels stay meaningful.
    selected_names = {canonical_json({
        key: roots[0][key] for key in ("name", "version", "source") if key in roots[0]
    })}
    selected_extras = {}
    pending = dependencies(roots[0].get("dependencies"), marker_environment)
    # Select groups via PEP 735 pyproject metadata, but follow the qualified
    # target-specific edges persisted by uv.lock.  Raw requirements can name
    # more than one universal-lock variant and are metadata only.
    for group, values in selected_groups.items():
        locked_edges = locked_dependency_groups.get(group)
        if locked_edges is None:
            # Older uv locks did not serialize dependency-group edges; retain
            # compatibility for those locks while modern locks stay qualified.
            pending.extend(dependencies(values, marker_environment))
        elif isinstance(locked_edges, list):
            pending.extend(dependencies(locked_edges, marker_environment))
        else:
            raise SystemExit(f"uv.lock selected dependency group is malformed: {group}")
    traversed_edges = set()
    while pending:
        edge = pending.pop()
        package = qualified_candidates(by_name, edge)
        name = normalized_name(package["name"])
        package_identity = canonical_json({
            key: package[key] for key in ("name", "version", "source") if key in package
        })
        extras = tuple(edge.get("extras", []))
        traversal = (package_identity, extras)
        if traversal in traversed_edges:
            continue
        traversed_edges.add(traversal)
        selected_names.add(package_identity)
        selected_extras.setdefault(package_identity, set()).update(extras)
        pending.extend(dependencies(package.get("dependencies"), marker_environment))
        optional_dependencies = package.get("optional-dependencies", {})
        if not isinstance(optional_dependencies, dict):
            raise SystemExit("uv.lock package optional-dependencies is malformed")
        for extra in extras:
            optional = optional_dependencies.get(extra)
            if optional is None:
                raise SystemExit(f"uv.lock package {package['name']} is missing selected extra {extra}")
            if not isinstance(optional, list):
                raise SystemExit("uv.lock optional dependency entry is malformed")
            pending.extend(dependencies(optional, marker_environment | {"extra": extra}))
    selected = []
    for package in packages:
        package_identity = canonical_json({
            key: package[key] for key in ("name", "version", "source") if key in package
        })
        if package_identity in selected_names:
            name = normalized_name(package["name"])
            projected_package = package
            if "optional-dependencies" in package:
                projected_package = dict(package)
                selected_optional_dependencies = {
                    extra: package["optional-dependencies"][extra]
                    for extra in sorted(selected_extras.get(package_identity, set()))
                }
                if selected_optional_dependencies:
                    projected_package["optional-dependencies"] = selected_optional_dependencies
                else:
                    projected_package.pop("optional-dependencies")
            # The root's version, dev-dependencies and build metadata are not
            # installed by `uv sync --no-dev --no-install-project`.  Keeping
            # them in the image contract makes a dev-only edit spuriously
            # require an image migration.  Retain only root fields that affect
            # the resolved runtime closure.
            if name == root_name:
                root_dependencies = [
                    dependency
                    for dependency in projected_package.get("dependencies", [])
                    if not isinstance(dependency, dict)
                    or not dependency.get("marker")
                    or Requirement(f"placeholder; {dependency['marker']}").marker.evaluate(marker_environment)
                ]
                selected.append(
                    {
                        key: (root_dependencies if key == "dependencies" else package[key])
                        for key in ("name", "source", "dependencies", "requires-python")
                        if key in projected_package
                    }
                )
            else:
                selected.append(projected_package)
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
        "target": {"baseImage": args.base_image, "platform": args.target_platform, "markerEnvironment": marker_environment},
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
