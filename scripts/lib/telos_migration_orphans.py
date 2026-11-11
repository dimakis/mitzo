"""Retain legacy orphan rows verbatim; never synthesize missing canonical items."""

from __future__ import annotations

import base64
import json
import sqlite3


def identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def typed_value(value):
    if isinstance(value, bytes):
        return {"sqliteBlobBase64": base64.b64encode(value).decode("ascii")}
    return value


def internal_rowid(db: sqlite3.Connection, table: str) -> str:
    columns = {
        row[1].lower()
        for row in db.execute("PRAGMA table_xinfo(" + identifier(table) + ")")
    }
    for alias in ("rowid", "_rowid_", "oid"):
        if alias not in columns:
            return identifier(alias)
    raise ValueError("Legacy table shadows every internal row identity")


def collect_orphans(db: sqlite3.Connection) -> dict | None:
    selected = {}
    for table, row_id, parent, foreign_key in db.execute("PRAGMA foreign_key_check"):
        # This explicit recovery applies only to legacy history/source evidence.
        # Unknown tables, relationships and non-rowid storage retain refusal.
        if (
            table not in {"history", "sources"}
            or parent != "items"
            or type(row_id) is not int
        ):
            raise ValueError("Unsupported legacy foreign-key violation")
        relation = [
            r
            for r in db.execute("PRAGMA foreign_key_list(" + identifier(table) + ")")
            if r[0] == foreign_key
        ]
        if len(relation) != 1 or relation[0][3:5] != ("item_id", "id"):
            raise ValueError("Unsupported legacy parent relationship")
        cursor = db.execute(
            "SELECT * FROM "
            + identifier(table)
            + " WHERE "
            + internal_rowid(db, table)
            + "=?",
            (row_id,),
        )
        matches = cursor.fetchall()
        if len(matches) != 1:
            raise ValueError("Legacy orphan changed")
        row = matches[0]
        selected[table, row_id] = {
            "table": table,
            "rowid": row_id,
            "columns": [c[0] for c in cursor.description],
            "values": [typed_value(value) for value in row],
        }
    if not selected:
        return None
    tables = sorted({table for table, _ in selected})
    return {
        "version": 1,
        "purpose": "legacy-orphan-recovery-only",
        "schemas": {
            table: db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()[0]
            for table in tables
        },
        "rows": [selected[key] for key in sorted(selected)],
    }


def excluded_rows(archive: dict | None) -> dict[str, set[int]]:
    result: dict[str, set[int]] = {}
    for row in archive["rows"] if archive else []:
        result.setdefault(row["table"], set()).add(row["rowid"])
    return result


def detach_orphans(db: sqlite3.Connection, archive: dict) -> None:
    for row in archive["rows"]:
        cursor = db.execute(
            "SELECT * FROM "
            + identifier(row["table"])
            + " WHERE "
            + internal_rowid(db, row["table"])
            + "=?",
            (row["rowid"],),
        )
        matches = cursor.fetchall()
        if (
            len(matches) != 1
            or [c[0] for c in cursor.description] != row["columns"]
            or [typed_value(value) for value in matches[0]] != row["values"]
        ):
            raise ValueError("Copied orphan differs from original evidence")
    for table, row_ids in excluded_rows(archive).items():
        removed = db.executemany(
            "DELETE FROM "
            + identifier(table)
            + " WHERE "
            + internal_rowid(db, table)
            + "=?",
            [(value,) for value in sorted(row_ids)],
        )
        if removed.rowcount != len(row_ids):
            raise ValueError("Copied orphan partition changed")


def archive_bytes(archive: dict) -> bytes:
    data = (
        json.dumps(archive, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    ).encode("utf8")
    # Match the runtime's bounded private archive admission.
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("Recovery archive exceeds the supported private bound")
    return data
