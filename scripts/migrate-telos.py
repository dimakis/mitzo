#!/usr/bin/env python3
"""Offline, lossless SQLite transfer. Never overwrites or deletes a source store.

Stop Mitzo AND every legacy refresh/CLI writer before invoking this command.
The flag acknowledges that operational prerequisite; the SQLite lock additionally
excludes a racing writer during capture. Keep the original for rollback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
from lib.telos_migration_orphans import (
    archive_bytes,
    collect_orphans,
    detach_orphans,
    excluded_rows,
    identifier,
    internal_rowid,
)


def inventory_pair(
    db: sqlite3.Connection,
    excluded: dict[str, set[int]] | None = None,
    *,
    rowids: bool = False,
) -> tuple[dict, dict]:
    """Hash original and retained views in one scan, including unknown/BLOB data."""
    schema = db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    ).fetchall()
    rowid_tables = set()
    if rowids:
        metadata = db.execute("PRAGMA table_list").fetchall()
        tables = {name for kind, name, _, _ in schema if kind == "table"}
        if (
            not metadata
            or any(len(row) < 5 for row in metadata)
            or not tables.issubset({row[1] for row in metadata if row[0] == "main"})
        ):
            raise ValueError("SQLite row identity metadata unavailable")
        rowid_tables = {row[1] for row in metadata if row[0] == "main" and row[4] == 0}
    digest = hashlib.sha256(json.dumps(schema).encode())
    retained_digest = digest.copy()
    counts = {}
    retained_counts = {}
    for kind, name, _, _ in schema:
        if kind != "table":
            continue
        rows = []
        retained_rows = []
        omitted = (excluded or {}).get(name, set())
        with_identity = bool(omitted) or name in rowid_tables
        query = (
            "SELECT "
            + (internal_rowid(db, name) + ",*" if with_identity else "*")
            + " FROM "
            + identifier(name)
        )
        for row in db.execute(query):
            keep = not omitted or row[0] not in omitted
            if with_identity and not rowids:
                row = row[1:]
            row_digest = hashlib.sha256()
            for value in row:
                encoded = value if isinstance(value, bytes) else str(value).encode()
                row_digest.update(
                    type(value).__name__.encode()
                    + b":"
                    + len(encoded).to_bytes(8, "big")
                )
                row_digest.update(encoded)
            rows.append(row_digest.digest())
            if keep:
                retained_rows.append(rows[-1])
        counts[name] = len(rows)
        retained_counts[name] = len(retained_rows)
        digest.update(name.encode())
        retained_digest.update(name.encode())
        for row_hash in sorted(rows):
            digest.update(row_hash)
        for row_hash in sorted(retained_rows):
            retained_digest.update(row_hash)
    metadata = {"rowIdentity": "sqlite-rowid-v1"} if rowids else {}
    return (
        {"sha256": digest.hexdigest(), "tables": counts, **metadata},
        {"sha256": retained_digest.hexdigest(), "tables": retained_counts, **metadata},
    )


def inventory(db: sqlite3.Connection, *, rowids: bool = False) -> dict:
    return inventory_pair(db, rowids=rowids)[0]


def migrate(source: Path, destination: Path, *, archive_orphans: bool = False) -> dict:
    source_stat = source.lstat()
    if (
        not stat.S_ISREG(source_stat.st_mode)
        or source_stat.st_uid != os.getuid()
        or source_stat.st_nlink != 1
    ):
        raise ValueError("Source must be an owned regular SQLite file")
    if source.is_symlink():
        raise ValueError("Source symlink refused")
    source = source.resolve(strict=True)
    if not destination.is_absolute() or source == destination.resolve():
        raise ValueError("A distinct absolute destination is required")
    for parent in (source.parent, destination.parent):
        if os.path.lexists(parent / ".telos-file-owners"):
            raise ValueError(
                "Retained SQLite owner family requires its coordinated restore procedure"
            )
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    parent = destination.parent.lstat()
    if (
        not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != os.getuid()
        or stat.S_IMODE(parent.st_mode) != 0o700
    ):
        raise ValueError(
            "Destination directory must be owned, private and not a symlink"
        )
    receipt_path = destination.with_name(destination.name + ".migration.json")
    recovery_path = destination.with_name(destination.name + ".recovery.json")
    if (
        os.path.lexists(destination)
        or os.path.lexists(receipt_path)
        or os.path.lexists(recovery_path)
        or any(destination.parent.glob(destination.name + "-*"))
    ):
        raise ValueError(
            "Destination database, sidecars or migration receipt already exist"
        )
    fd, temporary = tempfile.mkstemp(prefix=".telos-migration-", dir=destination.parent)
    os.close(fd)
    snapshot = Path(temporary)
    try:
        # Separate blocker and reader allow SQLite's online backup API to read
        # WAL pages while a reserved writer lock prevents concurrent mutation.
        uri = source.as_uri()
        with sqlite3.connect(uri + "?mode=rw", uri=True, timeout=1) as blocker:
            blocker.execute("BEGIN IMMEDIATE")
            with sqlite3.connect(uri + "?mode=ro", uri=True) as reader:
                reader.execute("BEGIN")
                archive = collect_orphans(reader) if archive_orphans else None
                expected, expected_runtime = inventory_pair(
                    reader, excluded_rows(archive), rowids=bool(archive)
                )
                if archive:
                    archive["sourceSnapshot"] = expected
                data = archive_bytes(archive) if archive else None
                archive_hash = hashlib.sha256(data).hexdigest() if data else None
                with sqlite3.connect(snapshot) as target:
                    reader.backup(target)
                    if archive:
                        # Exact copied orphan bytes plus the retained-view hash
                        # prove the original partition without rereading BLOBs.
                        detach_orphans(target, archive)
                        target.commit()
                    if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                        raise ValueError("Snapshot integrity verification failed")
                    if target.execute("PRAGMA foreign_key_check").fetchall():
                        raise ValueError("Snapshot contains broken foreign keys")
                    if inventory(target, rowids=bool(archive)) != expected_runtime:
                        raise ValueError("Runtime snapshot changed retained data")
                    if archive:
                        # Only this explicit metadata is added after proving the
                        # original partition. The DB itself requires its archive,
                        # including after a restore that omits both sibling files.
                        target.execute("""CREATE TABLE mitzo_telos_recovery_archive (
                          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                          schema_version INTEGER NOT NULL CHECK(schema_version=1),
                          sha256 TEXT NOT NULL
                        )""")
                        target.execute(
                            "INSERT INTO mitzo_telos_recovery_archive VALUES(1,1,?)",
                            (archive_hash,),
                        )
                        target.commit()
                    # A standalone snapshot has no dependency on source WAL files.
                    target.execute("PRAGMA journal_mode=DELETE")
                reader.rollback()
            with snapshot.open("rb") as stream:
                os.fsync(stream.fileno())
            result = {
                "ok": True,
                "verified": True,
                "version": 1,
                "snapshot": expected,
                "writersStoppedAcknowledged": True,
            }
            if archive:
                archive_fd = os.open(
                    recovery_path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                )
                with os.fdopen(archive_fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                result["version"] = 2
                result["runtimeSnapshot"] = expected_runtime
                result["recoveryArchive"] = {
                    "filename": recovery_path.name,
                    "sha256": archive_hash,
                    "rows": len(archive["rows"]),
                    "byTable": {
                        table: len(rows)
                        for table, rows in excluded_rows(archive).items()
                    },
                }
            # Exclusive link is atomic and refuses races or existing destinations.
            os.link(snapshot, destination)
            snapshot.unlink()
            receipt_fd = os.open(
                receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            with os.fdopen(receipt_fd, "w", encoding="utf8") as stream:
                json.dump(result, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            directory_fd = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            blocker.rollback()
        return result
    finally:
        # Preserve an already published destination after an uncertain failure.
        snapshot.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--writers-stopped", action="store_true", required=True)
    parser.add_argument(
        "--archive-orphans",
        action="store_true",
        help="Preserve legacy history/source orphan rows in a private recovery archive",
    )
    args = parser.parse_args()
    try:
        print(
            json.dumps(
                migrate(
                    args.source, args.destination, archive_orphans=args.archive_orphans
                )
            )
        )
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        # Do not print private rows or database contents on failure.
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": type(error).__name__,
                    "message": "Migration not confirmed; inspect destination before retrying.",
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
