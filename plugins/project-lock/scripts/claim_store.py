#!/usr/bin/env python3
"""Granular 4-tier lock_claims persistence, legacy sync, and deadlock BFS."""

from __future__ import annotations

import json
import sqlite3
from collections import deque
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import cast

from claim_policy import (
    MODE_PRIORITY,
    ClaimEntry,
    claims_conflict,
    compute_scope_key,
    make_claim_id,
)

ClaimDict = dict[str, object]
OwnerTreeFn = Callable[[dict[str, object], str], bool]
_MAX_LINEAGE_DEPTH = 8

_CLAIM_SCHEMA_SQL = (
    """
    CREATE TABLE IF NOT EXISTS lock_claims (
        claim_id TEXT PRIMARY KEY,
        module_key TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        file_relpath TEXT NOT NULL DEFAULT '',
        lock_mode TEXT NOT NULL,
        tool_call_id TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL,
        module_root TEXT NOT NULL,
        is_shared INTEGER NOT NULL DEFAULT 0,
        owner_project_id TEXT NOT NULL DEFAULT '',
        owner_transcript TEXT NOT NULL DEFAULT '',
        workspace TEXT NOT NULL DEFAULT '',
        child_ids_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        acquired_at REAL NOT NULL,
        last_active_at REAL NOT NULL,
        reserved_until REAL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_lock_claims_scope ON lock_claims(scope_key, lock_mode)",
    "CREATE INDEX IF NOT EXISTS idx_lock_claims_tool ON lock_claims(owner_id, tool_call_id)",
    """
    CREATE TABLE IF NOT EXISTS session_lineage (
        conv_id TEXT PRIMARY KEY,
        parent_conv_id TEXT NOT NULL DEFAULT '',
        root_conv_id TEXT NOT NULL DEFAULT '',
        transcript_path TEXT NOT NULL DEFAULT '',
        updated_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_lineage_root ON session_lineage(root_conv_id)",
)


def _rstr(row: sqlite3.Row, key: str) -> str:
    return str(cast(object, row[key]) or "")


def _col_str(row: object, idx: int, key: str) -> str:
    if isinstance(row, sqlite3.Row):
        return _rstr(row, key)
    if isinstance(row, Sequence):
        seq = cast(Sequence[object], row)
        if idx < len(seq):
            return str(seq[idx] or "")
    return ""


def _rint(row: sqlite3.Row, key: str) -> int:
    val = cast(object, row[key])
    return int(val) if isinstance(val, int | float | str) else 0


def _rfloat(row: sqlite3.Row, key: str) -> float:
    val = cast(object, row[key])
    return float(val) if isinstance(val, int | float) else 0.0


def _ropt_float(row: sqlite3.Row, key: str) -> float | None:
    val = cast(object, row[key])
    return float(val) if isinstance(val, int | float) else None


def _parse_json_list(raw: str) -> list[str]:
    try:
        obj: object = json.loads(raw)
    except ValueError:
        return []
    return [str(x) for x in cast(list[object], obj)] if isinstance(obj, list) else []


def ensure_claim_schema_tx(conn: sqlite3.Connection) -> None:
    """Create lock_claims/session_lineage tables and update lock_queue claim columns."""
    for stmt in _CLAIM_SCHEMA_SQL:
        _ = conn.execute(stmt)
    qcols = {_col_str(row, 1, "name") for row in conn.execute("PRAGMA table_info(lock_queue)").fetchall()}
    for col, ddl in (
        ("scope_key", "TEXT NOT NULL DEFAULT ''"),
        ("lock_mode", "TEXT NOT NULL DEFAULT 'BUILD_EXCL'"),
        ("file_relpath", "TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in qcols:
            _ = conn.execute(f"ALTER TABLE lock_queue ADD COLUMN {col} {ddl}")


def get_lineage_entry_tx(
    conn: sqlite3.Connection,
    conv_id: str,
) -> dict[str, str] | None:
    """Return stored session_lineage fields for conv_id, or None if absent."""
    cid = conv_id.strip()
    if not cid:
        return None
    row = conn.execute(
        """
        SELECT conv_id, parent_conv_id, root_conv_id, transcript_path
        FROM session_lineage
        WHERE conv_id = ?
        """,
        (cid,),
    ).fetchone()
    if row is None:
        return None
    return {
        "convId": _col_str(row, 0, "conv_id"),
        "parentConvId": _col_str(row, 1, "parent_conv_id"),
        "rootConvId": _col_str(row, 2, "root_conv_id"),
        "transcriptPath": _col_str(row, 3, "transcript_path"),
    }


def upsert_lineage_tx(
    conn: sqlite3.Connection,
    conv_id: str,
    *,
    parent_conv_id: str = "",
    root_conv_id: str = "",
    transcript_path: str = "",
    now: float,
) -> None:
    """Upsert session_lineage without clobbering existing non-empty fields."""
    cid = conv_id.strip()
    if not cid:
        return
    parent = parent_conv_id.strip()
    if parent == cid:
        parent = ""
    root = root_conv_id.strip()
    tpath = transcript_path.strip()

    existing = get_lineage_entry_tx(conn, cid)
    if existing is None:
        eff_parent = parent
        eff_root = root or parent or cid
        eff_transcript = tpath
    else:
        prev_parent = existing["parentConvId"]
        prev_root = existing["rootConvId"]
        prev_transcript = existing["transcriptPath"]
        eff_parent = parent or prev_parent
        eff_transcript = tpath or prev_transcript
        if root:
            eff_root = root
        elif parent and (not prev_root or prev_root == cid):
            eff_root = parent
        else:
            eff_root = prev_root or eff_parent or cid

    _ = conn.execute(
        """
        INSERT INTO session_lineage (
            conv_id, parent_conv_id, root_conv_id, transcript_path, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conv_id) DO UPDATE SET
            parent_conv_id = excluded.parent_conv_id,
            root_conv_id = excluded.root_conv_id,
            transcript_path = excluded.transcript_path,
            updated_at = excluded.updated_at
        """,
        (cid, eff_parent, eff_root, eff_transcript, now),
    )


def resolve_lineage_root_tx(conn: sqlite3.Connection, conv_id: str) -> str:
    """Walk parent_conv_id chain up to depth 8 with cycle protection."""
    cur = conv_id.strip()
    if not cur:
        return ""
    seen: set[str] = {cur}
    last_root = ""
    for _ in range(_MAX_LINEAGE_DEPTH):
        entry = get_lineage_entry_tx(conn, cur)
        if entry is None:
            return last_root if (last_root and last_root not in seen) else cur
        stored_root = entry["rootConvId"]
        parent = entry["parentConvId"]
        if not parent or parent in seen:
            return stored_root or cur
        last_root = stored_root
        seen.add(parent)
        cur = parent
    tail = get_lineage_entry_tx(conn, cur)
    if tail is not None and tail["rootConvId"]:
        return tail["rootConvId"]
    return cur


def row_to_claim_dict(row: sqlite3.Row) -> ClaimDict:
    return {
        "claimId": _rstr(row, "claim_id"),
        "moduleKey": _rstr(row, "module_key"),
        "scopeKey": _rstr(row, "scope_key"),
        "fileRelpath": _rstr(row, "file_relpath"),
        "lockMode": _rstr(row, "lock_mode"),
        "toolCallId": _rstr(row, "tool_call_id"),
        "ownerId": _rstr(row, "owner_id"),
        "moduleRoot": _rstr(row, "module_root"),
        "isShared": bool(_rint(row, "is_shared")),
        "ownerProjectId": _rstr(row, "owner_project_id"),
        "ownerTranscriptPath": _rstr(row, "owner_transcript"),
        "workspace": _rstr(row, "workspace"),
        "childIds": _parse_json_list(_rstr(row, "child_ids_json")),
        "tags": _parse_json_list(_rstr(row, "tags_json")),
        "acquiredAt": _rfloat(row, "acquired_at"),
        "lastActiveAt": _rfloat(row, "last_active_at"),
        "reservedUntil": _ropt_float(row, "reserved_until"),
    }


def _claim_expired(claim: ClaimDict, now: float, ttl_seconds: int) -> bool:
    res = claim.get("reservedUntil")
    if isinstance(res, int | float):
        return now >= float(res)
    last = claim.get("lastActiveAt")
    last_val = float(last) if isinstance(last, int | float) else now
    return (now - last_val) > ttl_seconds


def load_all_claims_tx(conn: sqlite3.Connection, now: float, ttl_seconds: int) -> list[ClaimDict]:
    """Load non-expired lock_claims plus orphan legacy locks synthesized as BUILD_EXCL."""
    lock_rows = conn.execute("SELECT * FROM locks ORDER BY module_key ASC").fetchall()
    lock_meta: dict[tuple[str, str], sqlite3.Row] = {
        (_rstr(r, "module_key"), _rstr(r, "owner_id")): r for r in lock_rows
    }

    claims: list[ClaimDict] = []
    seen_mod_owner: set[tuple[str, str]] = set()
    for row in conn.execute("SELECT * FROM lock_claims ORDER BY acquired_at ASC, claim_id ASC").fetchall():
        c = row_to_claim_dict(row)
        key = (str(c["moduleKey"]), str(c["ownerId"]))
        seen_mod_owner.add(key)
        legacy = lock_meta.get(key)
        if legacy is not None:
            l_last = _rfloat(legacy, "last_active_at")
            if l_last < float(cast(float, c["lastActiveAt"])):
                c["lastActiveAt"] = l_last
            l_res = _ropt_float(legacy, "reserved_until")
            if l_res is not None:
                c["reservedUntil"] = l_res
        if not _claim_expired(c, now, ttl_seconds):
            claims.append(c)

    for row in lock_rows:
        mod_key, owner_id = _rstr(row, "module_key"), _rstr(row, "owner_id")
        if (mod_key, owner_id) in seen_mod_owner:
            continue
        mod_root = Path(_rstr(row, "module_root"))
        synth: ClaimDict = {
            "claimId": f"legacy:{mod_key}:{owner_id}",
            "moduleKey": mod_key,
            "scopeKey": compute_scope_key(mod_key, mod_root),
            "fileRelpath": "",
            "lockMode": "BUILD_EXCL",
            "toolCallId": "",
            "ownerId": owner_id,
            "moduleRoot": str(mod_root),
            "isShared": bool(_rint(row, "is_shared")),
            "ownerProjectId": _rstr(row, "owner_project_id"),
            "ownerTranscriptPath": _rstr(row, "owner_transcript"),
            "workspace": _rstr(row, "workspace"),
            "childIds": _parse_json_list(_rstr(row, "child_ids_json")),
            "tags": _parse_json_list(_rstr(row, "tags_json")),
            "acquiredAt": _rfloat(row, "acquired_at"),
            "lastActiveAt": _rfloat(row, "last_active_at"),
            "reservedUntil": _ropt_float(row, "reserved_until"),
        }
        if not _claim_expired(synth, now, ttl_seconds):
            claims.append(synth)
    return claims


def sync_legacy_locks_tx(conn: sqlite3.Connection, module_keys: Iterable[str]) -> None:
    """Keep legacy `locks` table synchronized with representative lock_claims per module."""
    for mod_key in sorted({k for k in module_keys if k}):
        rows = conn.execute(
            "SELECT * FROM lock_claims WHERE module_key = ? ORDER BY acquired_at ASC",
            (mod_key,),
        ).fetchall()
        if not rows:
            _ = conn.execute("DELETE FROM locks WHERE module_key = ?", (mod_key,))
            continue

        claim_objs = [row_to_claim_dict(r) for r in rows]
        claim_objs.sort(
            key=lambda c: (MODE_PRIORITY.get(str(c["lockMode"]), 9), float(cast(float, c["acquiredAt"])))
        )
        primary = claim_objs[0]
        all_tags: list[str] = []
        for c in claim_objs:
            for t in cast(list[str], c["tags"]):
                if t not in all_tags:
                    all_tags.append(t)
        _ = conn.execute(
            """
            INSERT OR REPLACE INTO locks (
                module_key, module_root, is_shared, owner_id, owner_project_id,
                owner_transcript, workspace, child_ids_json, tags_json,
                acquired_at, last_active_at, reserved_until
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                mod_key,
                str(primary["moduleRoot"]),
                1 if primary["isShared"] else 0,
                str(primary["ownerId"]),
                str(primary["ownerProjectId"]),
                str(primary["ownerTranscriptPath"]),
                str(primary["workspace"]),
                json.dumps(primary["childIds"], ensure_ascii=False),
                json.dumps(all_tags, ensure_ascii=False),
                float(cast(float, primary["acquiredAt"])),
                max(float(cast(float, c["lastActiveAt"])) for c in claim_objs),
                primary.get("reservedUntil"),
            ),
        )


def detect_claim_cycle_tx(
    conn: sqlite3.Connection,
    requester_conv_id: str,
    blocking_owners: set[str],
    active_claims: Sequence[ClaimDict],
    same_owner_fn: OwnerTreeFn,
) -> tuple[str, ...] | None:
    held_by_req = [c for c in active_claims if same_owner_fn(c, requester_conv_id)]
    if not held_by_req:
        return None
    req_ids = {requester_conv_id} | {str(c["ownerId"]) for c in held_by_req}
    waiting_rows = conn.execute(
        "SELECT waiter_conv_id, module_key, scope_key, lock_mode, file_relpath "
        "FROM lock_queue WHERE status = 'waiting'"
    ).fetchall()

    adj: dict[str, set[str]] = {}
    for wrow in waiting_rows:
        waiter, wmod = _rstr(wrow, "waiter_conv_id"), _rstr(wrow, "module_key")
        wscope = _rstr(wrow, "scope_key")
        wmode = _rstr(wrow, "lock_mode") or "BUILD_EXCL"
        wfile = _rstr(wrow, "file_relpath")
        for c in active_claims:
            if same_owner_fn(c, waiter):
                continue
            hit = claims_conflict(wscope, wmode, wfile, c) if wscope else str(c["moduleKey"]) == wmod
            if hit:
                adj.setdefault(waiter, set()).add(str(c["ownerId"]))

    queue: deque[tuple[str, tuple[str, ...]]] = deque()
    visited: set[str] = set()
    for blk in sorted(blocking_owners):
        queue.append((blk, (requester_conv_id, blk)))
        visited.add(blk)

    while queue:
        node, path = queue.popleft()
        if node in req_ids or any(same_owner_fn(c, node) for c in held_by_req):
            return path
        for nxt in sorted(adj.get(node, set())):
            if nxt not in visited:
                visited.add(nxt)
                queue.append((nxt, (*path, nxt)))
    return None


def commit_claim_tx(
    conn: sqlite3.Connection,
    entry: ClaimEntry,
    owner_id: str,
    *,
    project_id: str,
    transcript: str,
    workspace: str,
    now: float,
    reserved_until: float | None = None,
) -> ClaimDict | None:
    """Upsert a granular claim into lock_claims and clear matching queue entry."""
    cid = make_claim_id(owner_id, entry.scope_key, entry.lock_mode, entry.file_relpath, entry.tool_call_id)
    existing = conn.execute("SELECT * FROM lock_claims WHERE claim_id = ?", (cid,)).fetchone()
    if existing is not None:
        prev = row_to_claim_dict(existing)
        tags = [t for t in cast(list[str], prev["tags"]) if t != "reserved"]
        if entry.reason_tag and entry.reason_tag not in tags:
            tags.append(entry.reason_tag)
        _ = conn.execute(
            """
            UPDATE lock_claims
            SET module_root = ?, is_shared = ?, owner_project_id = ?,
                owner_transcript = ?, workspace = ?, tags_json = ?,
                last_active_at = ?, reserved_until = ?
            WHERE claim_id = ?
            """,
            (
                str(entry.module_root),
                1 if entry.is_shared else 0,
                str(prev.get("ownerProjectId") or "") or project_id,
                str(prev.get("ownerTranscriptPath") or "") or transcript,
                str(prev.get("workspace") or "") or workspace,
                json.dumps(tags, ensure_ascii=False),
                now,
                reserved_until,
                cid,
            ),
        )
    else:
        init_tags = [entry.reason_tag] if entry.reason_tag else []
        if reserved_until is not None and "reserved" not in init_tags:
            init_tags.append("reserved")
        _ = conn.execute(
            """
            INSERT OR REPLACE INTO lock_claims (
                claim_id, module_key, scope_key, file_relpath, lock_mode, tool_call_id,
                owner_id, module_root, is_shared, owner_project_id, owner_transcript,
                workspace, child_ids_json, tags_json, acquired_at, last_active_at, reserved_until
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
            """,
            (
                cid, entry.module_key, entry.scope_key, entry.file_relpath, entry.lock_mode,
                entry.tool_call_id, owner_id, str(entry.module_root), 1 if entry.is_shared else 0,
                project_id, transcript, workspace, json.dumps(init_tags, ensure_ascii=False),
                now, now, reserved_until,
            ),
        )
    if reserved_until is None:
        _ = conn.execute(
            "DELETE FROM lock_queue WHERE module_key = ? AND waiter_conv_id = ?",
            (entry.module_key, owner_id),
        )
    row = conn.execute("SELECT * FROM lock_claims WHERE claim_id = ?", (cid,)).fetchone()
    return row_to_claim_dict(row) if row is not None else None


def expire_stale_claims_raw_tx(
    conn: sqlite3.Connection,
    now: float,
    ttl_seconds: int,
) -> tuple[list[tuple[str, str, float | None, float]], set[str]]:
    """Remove expired lock_claims honoring legacy locks.last_active_at adjustments."""
    lock_meta: dict[tuple[str, str], tuple[float, float | None]] = {
        (_rstr(lr, "module_key"), _rstr(lr, "owner_id")): (
            _rfloat(lr, "last_active_at"),
            _ropt_float(lr, "reserved_until"),
        )
        for lr in conn.execute("SELECT module_key, owner_id, last_active_at, reserved_until FROM locks").fetchall()
    }
    expired_events: list[tuple[str, str, float | None, float]] = []
    touched_modules: set[str] = set()
    for row in conn.execute("SELECT * FROM lock_claims").fetchall():
        c = row_to_claim_dict(row)
        mod_key, owner_id = str(c["moduleKey"]), str(c["ownerId"])
        meta = lock_meta.get((mod_key, owner_id))
        if meta is not None:
            l_last, l_res = meta
            if l_last < float(cast(float, c["lastActiveAt"])):
                c["lastActiveAt"] = l_last
            if l_res is not None:
                c["reservedUntil"] = l_res
        if not _claim_expired(c, now, ttl_seconds):
            continue
        _ = conn.execute("DELETE FROM lock_claims WHERE claim_id = ?", (str(c["claimId"]),))
        _ = conn.execute(
            "DELETE FROM lock_queue WHERE module_key = ? AND waiter_conv_id = ? AND status = 'promoted'",
            (mod_key, owner_id),
        )
        expired_events.append((mod_key, owner_id, _ropt_float(row, "reserved_until"), float(cast(float, c["lastActiveAt"]))))
        touched_modules.add(mod_key)

    if touched_modules:
        sync_legacy_locks_tx(conn, touched_modules)
    return expired_events, touched_modules
