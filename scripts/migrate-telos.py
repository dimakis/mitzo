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


def identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def inventory(db: sqlite3.Connection) -> dict:
    """Hash all schema and typed row values, including unknown tables and BLOBs."""
    schema = db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    ).fetchall()
    digest = hashlib.sha256(json.dumps(schema).encode())
    counts = {}
    for kind, name, _, _ in schema:
        if kind != "table":
            continue
        rows = []
        for row in db.execute("SELECT * FROM " + identifier(name)):
            encoded = [
                {"blob": value.hex()} if isinstance(value, bytes) else value
                for value in row
            ]
            rows.append(hashlib.sha256(json.dumps(encoded).encode()).digest())
        counts[name] = len(rows)
        digest.update(name.encode())
        for row_hash in sorted(rows):
            digest.update(row_hash)
    return {"sha256": digest.hexdigest(), "tables": counts}


def migrate(source: Path, destination: Path) -> dict:
    source_stat = source.lstat()
    if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_uid != os.getuid() or source_stat.st_nlink != 1:
        raise ValueError("Source must be an owned regular SQLite file")
    if source.is_symlink():
        raise ValueError("Source symlink refused")
    source = source.resolve(strict=True)
    if not destination.is_absolute() or source == destination.resolve():
        raise ValueError("A distinct absolute destination is required")
    for parent in (source.parent, destination.parent):
        if (parent / ".telos-file-owners").exists():
            raise ValueError("Retained SQLite owner family requires its coordinated restore procedure")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    parent = destination.parent.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != 0o700):
        raise ValueError("Destination directory must be owned, private and not a symlink")
    receipt_path = destination.with_name(destination.name + ".migration.json")
    if (os.path.lexists(destination) or os.path.lexists(receipt_path)
            or any(destination.parent.glob(destination.name + "-*"))):
        raise ValueError("Destination database, sidecars or migration receipt already exist")
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
                expected = inventory(reader)
                with sqlite3.connect(snapshot) as target:
                    reader.backup(target)
                    if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                        raise ValueError("Snapshot integrity verification failed")
                    if target.execute("PRAGMA foreign_key_check").fetchall():
                        raise ValueError("Snapshot contains broken foreign keys")
                    if inventory(target) != expected:
                        raise ValueError("Snapshot did not preserve the complete database")
                    # A standalone snapshot has no dependency on source WAL files.
                    target.execute("PRAGMA journal_mode=DELETE")
                reader.rollback()
            with snapshot.open("rb") as stream:
                os.fsync(stream.fileno())
            result = {"ok": True, "verified": True, "version": 1,
                      "snapshot": expected, "writersStoppedAcknowledged": True}
            # Exclusive link is atomic and refuses races or existing destinations.
            os.link(snapshot, destination)
            snapshot.unlink()
            with receipt_path.open("x", encoding="utf8") as stream:
                os.chmod(receipt_path, 0o600)
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
    args = parser.parse_args()
    try:
        print(json.dumps(migrate(args.source, args.destination)))
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        # Do not print private rows or database contents on failure.
        print(json.dumps({"ok": False, "error": type(error).__name__,
                          "message": "Migration not confirmed; inspect destination before retrying."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
