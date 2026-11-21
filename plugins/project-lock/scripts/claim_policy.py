#!/usr/bin/env python3
"""Pure policy, path normalization, scope hashing, and 4-tier compatibility rules."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from pathlib import Path

CLAIM_MODES = ("FILE_WRITE", "TEST_SHARED", "BUILD_EXCL")
MODE_PRIORITY = {"BUILD_EXCL": 0, "FILE_WRITE": 1, "TEST_SHARED": 2}


@dataclass(frozen=True)
class ClaimEntry:
    """Normalized claim descriptor persisted in lock_claims."""

    module_key: str
    module_root: Path
    is_shared: bool
    scope_key: str
    lock_mode: str
    file_relpath: str
    reason_tag: str
    tool_call_id: str = ""


def compute_scope_key(module_key: str, module_root: Path) -> str:
    """Scope locks to canonical physical directory root (isolates worktrees)."""
    canon = str(module_root.resolve(strict=False)).lower()
    digest = hashlib.sha1(canon.encode("utf-8"), usedforsecurity=False).hexdigest()[:8]
    return f"{module_key}@{digest}"


def normalize_file_relpath(
    raw_path: str | Path,
    module_root: Path,
    cwd: str | Path | None = None,
) -> str:
    """Normalize an edit path relative to module_root for FILE_WRITE isolation."""
    raw = str(raw_path).strip()
    if not raw:
        return ""
    p = Path(raw)
    if not p.is_absolute() and cwd:
        p = Path(cwd) / p
    resolved = p.resolve(strict=False)
    root_res = module_root.resolve(strict=False)
    if resolved == root_res:
        return ""
    try:
        rel = resolved.relative_to(root_res)
        return rel.as_posix().lower()
    except ValueError:
        return ""


def claims_conflict(
    req_scope: str,
    req_mode: str,
    req_file: str,
    existing: dict[str, object],
) -> bool:
    """Mode-aware 4-tier compatibility check on matching physical scope_key."""
    if req_scope != str(existing.get("scopeKey") or ""):
        return False
    ex_mode = str(existing.get("lockMode") or "BUILD_EXCL")
    if req_mode == "BUILD_EXCL" or ex_mode == "BUILD_EXCL":
        return True
    if "TEST_SHARED" in {req_mode, ex_mode}:
        return False
    ex_file = str(existing.get("fileRelpath") or "")
    return req_file == "" or ex_file == "" or req_file == ex_file


def make_claim_id(
    owner_id: str,
    scope_key: str,
    lock_mode: str,
    file_relpath: str,
    tool_call_id: str,
) -> str:
    """Build deterministic claim id; tool-scoped barriers use the cmd: prefix."""
    if tool_call_id:
        token = f"{scope_key}|{lock_mode}|{file_relpath}|{tool_call_id}"
        return f"cmd:{owner_id[:8]}:{uuid.uuid5(uuid.NAMESPACE_URL, token).hex[:16]}"
    raw = f"{owner_id}|{scope_key}|{lock_mode}|{file_relpath}"
    return f"clm:{uuid.uuid5(uuid.NAMESPACE_URL, raw).hex[:20]}"
