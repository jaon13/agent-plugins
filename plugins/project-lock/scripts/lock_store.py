#!/usr/bin/env python3
"""SQLite WAL module-unit lock store, FIFO queue, Wait-For detector, and OS probes."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from collections import deque
from collections.abc import Generator, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast
from urllib.parse import unquote, urlparse

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from lock_config import WorkspaceLockConfig, load_workspace_config

_INITIAL_LOCK_ROOT = Path(
    os.environ.get("PROJECT_LOCK_DIR", str(Path.home() / ".agents" / "locks"))
).resolve()
LOCK_ROOT = _INITIAL_LOCK_ROOT
_INITIAL_LOCK_DB = _INITIAL_LOCK_ROOT / "locks.db"
LOCK_DB = _INITIAL_LOCK_DB
_INITIAL_HISTORY_LOG = _INITIAL_LOCK_ROOT / "history.log"
HISTORY_LOG = _INITIAL_HISTORY_LOG
_INITIAL_NEW_ROOT = Path(
    os.environ.get("PROJECT_LOCK_WORKSPACE_ROOT", "")
).resolve() if os.environ.get("PROJECT_LOCK_WORKSPACE_ROOT", "").strip() else None
NEW_ROOT = _INITIAL_NEW_ROOT

DEFAULT_TTL_SECONDS = 1200  # 20 minutes idle safety expiration
RESERVATION_TTL_SECONDS = 60  # 60s reservation window on promotion
DEFAULT_MAX_LOCKS_PER_SESSION = 4
DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS = 3
BUSY_TIMEOUT_MS = 5000
MAX_ROOT_WALK_DEPTH = 10
MIN_COMMON_PARTS = 3
MIN_MODULE_PARTS = 2
SHORT_ID_LEN = 8
MAX_CHAIN_PREVIEW = 8
WIN_SHARING_VIOLATION = 32
GIT_TIMEOUT_SECONDS = 2
INIT_MAX_RETRIES = 20
INIT_RETRY_SLEEP = 0.05

EXEMPT_PREFIXES = (
    (Path.home() / ".gemini").resolve(),
    (Path.home() / ".agents").resolve(),
    (Path.home() / ".cursor").resolve(),
)
EXEMPT_SEGMENTS = (".xray", ".code_graph", ".agents", ".vs", "node_modules")

ROOT_MARKERS = (".git", "Cargo.toml", "package.json", "pyproject.toml")

_NON_SPAWN_TOOL_MARKERS = (
    "Command exited with code ",
    "Command output:",
    "Showing lines ",
    "Partial read (",
    "Tool is running as a background task",
)
_EXCLUDED_TRANSCRIPT_TYPES = frozenset(
    {"USER_INPUT", "CHECKPOINT", "SYSTEM_MESSAGE"}
)
_SUBAGENT_HEADER = "Created the following subagent:"
_LEGACY_CHILD_KEYS = ("child", "childId", "conversationId", "conversation_id")

AcquireStatus = Literal["ACQUIRED", "QUEUED", "DEADLOCK_RISK", "LIMIT_EXCEEDED"]
LockDict = dict[str, object]
QueueDict = dict[str, object]
EventDict = dict[str, object]

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS locks (
        module_key TEXT PRIMARY KEY,
        module_root TEXT NOT NULL,
        is_shared INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT NOT NULL,
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
    """
    CREATE TABLE IF NOT EXISTS lock_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_group_id TEXT NOT NULL,
        module_key TEXT NOT NULL,
        waiter_conv_id TEXT NOT NULL,
        waiter_project_id TEXT NOT NULL DEFAULT '',
        waiter_workspace TEXT NOT NULL DEFAULT '',
        session_kind TEXT NOT NULL DEFAULT 'unknown',
        reason_tag TEXT NOT NULL DEFAULT 'edit',
        status TEXT NOT NULL DEFAULT 'waiting',
        wake_status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        requested_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(module_key, waiter_conv_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_lock_queue_module_status_id
        ON lock_queue(module_key, status, id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_lock_queue_group
        ON lock_queue(request_group_id, waiter_conv_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS lock_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        event TEXT NOT NULL,
        module_key TEXT NOT NULL DEFAULT '',
        conv_id TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_lock_events_ts ON lock_events(ts DESC)
    """,
    """
    CREATE TABLE IF NOT EXISTS lock_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
)


@dataclass(frozen=True)
class ModuleTarget:
    key: str
    root: Path
    is_shared: bool


@dataclass(frozen=True)
class SessionContext:
    project_id: str = ""
    transcript_path: str = ""
    workspace: str = ""
    session_kind: str = "unknown"


@dataclass(frozen=True)
class PromotionNotice:
    request_group_id: str
    modules: tuple[str, ...]
    waiter_conv_id: str
    waiter_project_id: str
    waiter_workspace: str
    session_kind: str
    reason_tag: str
    reserved_until: float


@dataclass(frozen=True)
class GuardSettings:
    max_locks_per_session: int = DEFAULT_MAX_LOCKS_PER_SESSION
    max_shared_deps_without_nodeps: int = DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS


@dataclass(frozen=True)
class AcquireResult:
    acquired: bool
    status: AcquireStatus
    locks: tuple[LockDict, ...] = ()
    conflicts: tuple[LockDict, ...] = ()
    request_group_id: str = ""
    queue_position: int = 0
    deadlock_chain: tuple[str, ...] = ()
    expired_promotions: tuple[PromotionNotice, ...] = ()
    held_modules: tuple[str, ...] = ()
    limit: int = 0


@dataclass(frozen=True)
class ReleaseResult:
    released: tuple[LockDict, ...] = ()
    promotions: tuple[PromotionNotice, ...] = ()


def _effective_lock_root() -> Path:
    if LOCK_ROOT != _INITIAL_LOCK_ROOT:
        return LOCK_ROOT.resolve()
    env_dir = os.environ.get("PROJECT_LOCK_DIR")
    if env_dir:
        return Path(env_dir).resolve()
    return LOCK_ROOT.resolve()


def _effective_db_path() -> Path:
    if LOCK_DB != _INITIAL_LOCK_DB:
        return LOCK_DB.resolve()
    return _effective_lock_root() / "locks.db"


def _effective_history_log() -> Path:
    if HISTORY_LOG != _INITIAL_HISTORY_LOG:
        return HISTORY_LOG.resolve()
    return _effective_lock_root() / "history.log"


def get_workspace_config() -> WorkspaceLockConfig:
    return load_workspace_config(_effective_lock_root())


def _effective_new_root(cfg: WorkspaceLockConfig | None = None) -> Path | None:
    if NEW_ROOT != _INITIAL_NEW_ROOT and NEW_ROOT is not None:
        return NEW_ROOT.resolve()
    env_new = os.environ.get("PROJECT_LOCK_WORKSPACE_ROOT", "").strip()
    if env_new:
        return Path(env_new).expanduser().resolve(strict=False)
    active_cfg = cfg if cfg is not None else get_workspace_config()
    return active_cfg.workspace_root


def _is_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(parent.resolve(strict=False))
        return True
    except ValueError:
        return False


def is_exempt_path(raw_path: str | Path) -> bool:
    p = Path(raw_path).resolve(strict=False)
    if any(_is_under(p, ex) for ex in EXEMPT_PREFIXES):
        return True
    raw_temp = os.environ.get("TEMP", "") or os.environ.get("TMP", "")
    temp_dir = Path(raw_temp or tempfile.gettempdir()).resolve(strict=False)
    if _is_under(p, temp_dir):
        return True
    parts_low = [seg.lower() for seg in p.parts]
    return any(seg in EXEMPT_SEGMENTS for seg in parts_low)


def _ext_digest(path: Path) -> str:
    raw = str(path).lower().encode("utf-8")
    return hashlib.sha1(raw, usedforsecurity=False).hexdigest()[:SHORT_ID_LEN]


def resolve_module_target(
    raw_path: str | Path,
    fallback_cwd: str | Path | None = None,
) -> ModuleTarget | None:
    p = Path(raw_path)
    if not p.is_absolute() and fallback_cwd:
        p = Path(fallback_cwd) / p
    resolved = p.resolve(strict=False)
    if is_exempt_path(resolved):
        return None

    cfg = get_workspace_config()
    new_root = _effective_new_root(cfg)
    if new_root is not None:
        try:
            rel = resolved.relative_to(new_root)
            return _resolve_under_new_root(rel, new_root, cfg)
        except ValueError:
            pass

    cur = resolved if resolved.is_dir() else resolved.parent
    for _ in range(MAX_ROOT_WALK_DEPTH):
        has_marker = any((cur / marker).exists() for marker in ROOT_MARKERS)
        has_sln = any(cur.glob("*.slnx")) or any(cur.glob("*.sln"))
        if has_marker or has_sln:
            return ModuleTarget(f"ext/{cur.name}_{_ext_digest(cur)}", cur, False)
        if cur.parent == cur:
            break
        cur = cur.parent

    if fallback_cwd:
        base = Path(fallback_cwd).resolve(strict=False)
        if not is_exempt_path(base):
            return ModuleTarget(f"ext/{base.name}_{_ext_digest(base)}", base, False)
    return None


def _resolve_under_new_root(
    rel: Path,
    new_root: Path,
    cfg: WorkspaceLockConfig | None = None,
) -> ModuleTarget | None:
    active_cfg = cfg if cfg is not None else get_workspace_config()
    parts = rel.parts
    if not parts:
        return None
    top = parts[0].lower()
    target: ModuleTarget | None = None
    if top in active_cfg.shared_src_groups:
        if (
            len(parts) >= MIN_COMMON_PARTS
            and parts[1].lower() == "src"
            and not parts[2].startswith(".")
        ):
            mod = parts[2]
            target = ModuleTarget(
                f"{parts[0]}/{mod}", new_root / parts[0] / parts[1] / mod, True
            )
        else:
            target = ModuleTarget(f"{parts[0]}/_root", new_root / parts[0], True)
    elif top in active_cfg.shared_groups:
        if len(parts) >= MIN_MODULE_PARTS and not parts[1].startswith("."):
            mod = parts[1]
            target = ModuleTarget(
                f"{parts[0]}/{mod}", new_root / parts[0] / mod, True
            )
        else:
            target = ModuleTarget(f"{parts[0]}/_root", new_root / parts[0], True)
    elif top in active_cfg.app_groups:
        if len(parts) >= MIN_MODULE_PARTS and not parts[1].startswith("."):
            app = parts[1]
            target = ModuleTarget(
                f"{parts[0]}/{app}", new_root / parts[0] / app, False
            )
        else:
            target = ModuleTarget(f"{parts[0]}/_root", new_root / parts[0], False)
    else:
        target = ModuleTarget(f"{new_root.name}/{parts[0]}", new_root / parts[0], False)
    return target


def _infer_module_meta(
    module_key: str,
    fallback_workspace: str = "",
) -> tuple[str, bool]:
    cfg = get_workspace_config()
    new_root = _effective_new_root(cfg)
    if "/" not in module_key:
        root = Path(fallback_workspace) if fallback_workspace else Path(module_key)
        return str(root), False
    prefix, name = module_key.split("/", 1)
    low = prefix.lower()
    result = (fallback_workspace or module_key, False)
    if new_root is not None and low in cfg.shared_src_groups:
        root = (
            new_root / prefix
            if name == "_root"
            else new_root / prefix / "src" / name
        )
        result = (str(root), True)
    elif new_root is not None and low in cfg.shared_groups:
        root = new_root / prefix if name == "_root" else new_root / prefix / name
        result = (str(root), True)
    elif new_root is not None and low in cfg.app_groups:
        root = new_root / prefix if name == "_root" else new_root / prefix / name
        result = (str(root), False)
    elif new_root is not None and prefix.lower() == new_root.name.lower():
        result = (str(new_root / name), False)
    return result


def infer_module_target(
    raw_spec: str,
    fallback_cwd: str | Path | None = None,
) -> ModuleTarget | None:
    cleaned = raw_spec.strip()
    if not cleaned:
        return None
    p = Path(cleaned)
    looks_like_path = p.is_absolute() or "\\" in cleaned or cleaned.startswith((".", "~"))
    if looks_like_path or p.exists():
        return resolve_module_target(cleaned, fallback_cwd=fallback_cwd)
    if fallback_cwd is not None:
        rel_candidate = Path(fallback_cwd) / cleaned
        if rel_candidate.exists():
            return resolve_module_target(rel_candidate, fallback_cwd=fallback_cwd)
    root_str, is_shared = _infer_module_meta(cleaned, str(fallback_cwd or ""))
    return ModuleTarget(cleaned, Path(root_str), is_shared)


def safe_lock_filename(module_key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "__", module_key.strip("/")) + ".lock.json"


def _connect_raw(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(
        str(db_path),
        timeout=BUSY_TIMEOUT_MS / 1000.0,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    _ = conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    return conn


@contextmanager
def _write_tx(conn: sqlite3.Connection) -> Generator[None]:
    _ = conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        _ = conn.execute("COMMIT")
    except BaseException:
        with suppress(sqlite3.Error):
            _ = conn.execute("ROLLBACK")
        raise


def _row_str(row: sqlite3.Row, col: str) -> str:
    return str(cast(object, row[col]) or "")


def _row_int(row: sqlite3.Row, col: str) -> int:
    return int(cast(int | float | str, row[col]))


def _row_float(row: sqlite3.Row, col: str) -> float:
    return float(cast(int | float | str, row[col]))


def _row_opt_float(row: sqlite3.Row, col: str) -> float | None:
    raw = cast(int | float | str | None, row[col])
    return None if raw is None else float(raw)


def _parse_json_str_list(raw: str) -> list[str]:
    try:
        parsed: object = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    items = cast(list[object], parsed)
    return [str(item) for item in items]


def _coerce_str_list(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item) for item in cast(list[object], raw)]


def _log_event_tx(
    conn: sqlite3.Connection,
    event: str,
    module_key: str = "",
    conv_id: str = "",
    detail: str = "",
) -> None:
    _ = conn.execute(
        "INSERT INTO lock_events (ts, event, module_key, conv_id, detail) "
        "VALUES (?, ?, ?, ?, ?)",
        (time.time(), event, module_key, conv_id, detail),
    )


def _migrate_legacy_json_tx(
    conn: sqlite3.Connection,
    lock_root: Path,
    now: float,
) -> None:
    flag_row = conn.execute(
        "SELECT value FROM lock_settings WHERE key = 'legacy_json_migrated'"
    ).fetchone()
    if flag_row is not None and _row_str(flag_row, "value") == "1":
        return

    for lp in sorted(lock_root.glob("*.lock.json")):
        try:
            raw_obj: object = json.loads(lp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            lp.unlink(missing_ok=True)
            continue

        if not isinstance(raw_obj, dict):
            lp.unlink(missing_ok=True)
            continue

        data = cast(dict[str, object], raw_obj)
        mod_key = str(data.get("moduleKey") or "")
        owner_id = str(data.get("ownerId") or "")
        acq = float(cast(int | float, data.get("acquiredAt") or now))
        last_act = float(cast(int | float, data.get("lastActiveAt") or acq))
        if mod_key and owner_id and (now - last_act) <= DEFAULT_TTL_SECONDS:
            child_ids = _coerce_str_list(data.get("childIds"))
            tags = _coerce_str_list(data.get("tags"))
            _ = conn.execute(
                """
                INSERT OR IGNORE INTO locks (
                    module_key, module_root, is_shared, owner_id, owner_project_id,
                    owner_transcript, workspace, child_ids_json, tags_json,
                    acquired_at, last_active_at, reserved_until
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    mod_key,
                    str(data.get("moduleRoot") or ""),
                    1 if data.get("isShared") else 0,
                    owner_id,
                    str(data.get("ownerProjectId") or ""),
                    str(data.get("ownerTranscriptPath") or ""),
                    str(data.get("workspace") or ""),
                    json.dumps(child_ids, ensure_ascii=False),
                    json.dumps(tags, ensure_ascii=False),
                    acq,
                    last_act,
                ),
            )
            _log_event_tx(conn, "MIGRATED", mod_key, owner_id, f"from={lp.name}")
        lp.unlink(missing_ok=True)

    _ = conn.execute(
        "INSERT OR REPLACE INTO lock_settings (key, value) "
        "VALUES ('legacy_json_migrated', '1')"
    )


def _ensure_lock_queue_columns_tx(conn: sqlite3.Connection) -> None:
    cols = {
        _row_str(row, "name")
        for row in conn.execute("PRAGMA table_info(lock_queue)").fetchall()
    }
    if "wake_status" not in cols:
        _ = conn.execute(
            "ALTER TABLE lock_queue "
            "ADD COLUMN wake_status TEXT NOT NULL DEFAULT 'pending'"
        )


def init_db() -> Path:
    lock_root = _effective_lock_root()
    lock_root.mkdir(parents=True, exist_ok=True)
    db_path = _effective_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    last_err: sqlite3.OperationalError | None = None
    for _ in range(INIT_MAX_RETRIES):
        conn = _connect_raw(db_path)
        try:
            _ = conn.execute("PRAGMA journal_mode=WAL")
            _ = conn.execute("PRAGMA synchronous=NORMAL")
            with _write_tx(conn):
                for stmt in _SCHEMA_STATEMENTS:
                    _ = conn.execute(stmt)
                _ensure_lock_queue_columns_tx(conn)
                for setting_key, setting_val in (
                    ("auto_wake_enabled", "1"),
                    ("max_locks_per_session", str(DEFAULT_MAX_LOCKS_PER_SESSION)),
                    (
                        "max_shared_deps_without_nodeps",
                        str(DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS),
                    ),
                ):
                    _ = conn.execute(
                        "INSERT OR IGNORE INTO lock_settings (key, value) "
                        "VALUES (?, ?)",
                        (setting_key, setting_val),
                    )
                _migrate_legacy_json_tx(conn, lock_root, time.time())
            return db_path
        except sqlite3.OperationalError as exc:
            last_err = exc
            time.sleep(INIT_RETRY_SLEEP)
        finally:
            conn.close()

    if last_err is not None:
        raise last_err
    return db_path


@contextmanager
def _db_conn() -> Generator[sqlite3.Connection]:
    db_path = init_db()
    conn = _connect_raw(db_path)
    try:
        yield conn
    finally:
        conn.close()


def _row_to_lock_dict(row: sqlite3.Row) -> LockDict:
    return {
        "moduleKey": _row_str(row, "module_key"),
        "moduleRoot": _row_str(row, "module_root"),
        "isShared": bool(_row_int(row, "is_shared")),
        "ownerId": _row_str(row, "owner_id"),
        "ownerProjectId": _row_str(row, "owner_project_id"),
        "ownerTranscriptPath": _row_str(row, "owner_transcript"),
        "workspace": _row_str(row, "workspace"),
        "childIds": _parse_json_str_list(_row_str(row, "child_ids_json")),
        "tags": _parse_json_str_list(_row_str(row, "tags_json")),
        "acquiredAt": _row_float(row, "acquired_at"),
        "lastActiveAt": _row_float(row, "last_active_at"),
        "reservedUntil": _row_opt_float(row, "reserved_until"),
    }


def _row_to_queue_dict(row: sqlite3.Row, position: int = 0) -> QueueDict:
    return {
        "id": _row_int(row, "id"),
        "requestGroupId": _row_str(row, "request_group_id"),
        "moduleKey": _row_str(row, "module_key"),
        "waiterConvId": _row_str(row, "waiter_conv_id"),
        "waiterProjectId": _row_str(row, "waiter_project_id"),
        "waiterWorkspace": _row_str(row, "waiter_workspace"),
        "sessionKind": _row_str(row, "session_kind"),
        "reasonTag": _row_str(row, "reason_tag"),
        "status": _row_str(row, "status"),
        "wakeStatus": _row_str(row, "wake_status") or "pending",
        "retryCount": _row_int(row, "retry_count"),
        "requestedAt": _row_float(row, "requested_at"),
        "updatedAt": _row_float(row, "updated_at"),
        "position": position,
    }


def _matches_legacy_spawn_record(
    obj: dict[str, object],
    current_conv_id: str,
) -> bool:
    if obj.get("type") != "tool_call":
        return False
    for key in _LEGACY_CHILD_KEYS:
        if obj.get(key) == current_conv_id:
            return True
    children = obj.get("children")
    return isinstance(children, list) and current_conv_id in children


def _count_pending_spawns(obj: dict[str, object]) -> tuple[int, int]:
    tool_calls = obj.get("tool_calls")
    if not isinstance(tool_calls, list):
        return 0, 0
    subagent_cnt = 0
    swarm_add_cnt = 0
    for tc in cast(list[object], tool_calls):
        if not isinstance(tc, dict):
            continue
        tc_map = cast(dict[str, object], tc)
        name = tc_map.get("name")
        if name == "invoke_subagent":
            subagent_cnt += 1
        elif name == "swarm":
            args = tc_map.get("args")
            if isinstance(args, dict):
                raw_action = cast(dict[str, object], args).get("action", "")
                if str(raw_action).strip().strip('"').lower() == "add":
                    swarm_add_cnt += 1
    return subagent_cnt, swarm_add_cnt


def _strip_step_timestamps(content: str) -> str:
    lines = content.splitlines()
    idx = 0
    while idx < len(lines) and (
        lines[idx].startswith("Created At:")
        or lines[idx].startswith("Completed At:")
    ):
        idx += 1
    return "\n".join(lines[idx:]).strip()


def _extract_spawned_child_ids(content: str) -> tuple[str, set[str]]:
    if any(marker in content for marker in _NON_SPAWN_TOOL_MARKERS):
        return "", set()
    body = _strip_step_timestamps(content)
    if body.startswith(_SUBAGENT_HEADER):
        after_hdr = body[len(_SUBAGENT_HEADER) :].lstrip()
        if not after_hdr.startswith("{"):
            return "", set()
        try:
            parsed, _ = json.JSONDecoder().raw_decode(after_hdr)
        except ValueError:
            return "", set()
        if isinstance(parsed, dict):
            cid = cast(dict[str, object], parsed).get("conversationId")
            if isinstance(cid, str) and cid:
                return "subagent", {cid}
        return "subagent", set()

    if body.startswith("{"):
        try:
            parsed, _ = json.JSONDecoder().raw_decode(body)
        except ValueError:
            return "", set()
        if not isinstance(parsed, dict):
            return "", set()
        pmap = cast(dict[str, object], parsed)
        if pmap.get("status") != "added":
            return "", set()
        ids: set[str] = set()
        cid = pmap.get("conversation_id")
        if isinstance(cid, str) and cid:
            ids.add(cid)
        members = pmap.get("members")
        if isinstance(members, list):
            for member in cast(list[object], members):
                if isinstance(member, dict):
                    mcid = cast(dict[str, object], member).get("conversation_id")
                    if isinstance(mcid, str) and mcid:
                        ids.add(mcid)
        return "swarm", ids

    return "", set()


def _parse_jsonl_dict(line: str) -> dict[str, object] | None:
    try:
        raw_obj: object = json.loads(line)
    except ValueError:
        return None
    if not isinstance(raw_obj, dict):
        return None
    return cast(dict[str, object], raw_obj)


def _line_needs_spawn_parse(
    line: str,
    current_conv_id: str,
    pending_subagents: int,
    pending_swarms: int,
) -> bool:
    if current_conv_id in line:
        return True
    if '"PLANNER_RESPONSE"' in line:
        if pending_subagents > 0 or pending_swarms > 0:
            return True
        return '"invoke_subagent"' in line or '"swarm"' in line
    return (pending_subagents > 0 or pending_swarms > 0) and '"GENERIC"' in line


def _process_spawn_step(
    obj: dict[str, object],
    current_conv_id: str,
    pending_subagents: int,
    pending_swarms: int,
) -> tuple[bool, int, int]:
    if _matches_legacy_spawn_record(obj, current_conv_id):
        return True, pending_subagents, pending_swarms
    step_type = obj.get("type")
    if step_type == "PLANNER_RESPONSE":
        sub_cnt, swarm_cnt = _count_pending_spawns(obj)
        return False, sub_cnt, swarm_cnt
    if (
        step_type in _EXCLUDED_TRANSCRIPT_TYPES
        or obj.get("source") == "USER_EXPLICIT"
        or step_type != "GENERIC"
    ):
        return False, pending_subagents, pending_swarms
    if pending_subagents <= 0 and pending_swarms <= 0:
        return False, pending_subagents, pending_swarms
    content = obj.get("content")
    if not isinstance(content, str):
        return False, pending_subagents, pending_swarms
    kind, child_ids = _extract_spawned_child_ids(content)
    if kind == "subagent" and pending_subagents > 0:
        return current_conv_id in child_ids, pending_subagents - 1, pending_swarms
    if kind == "swarm" and pending_swarms > 0:
        return current_conv_id in child_ids, pending_subagents, pending_swarms - 1
    return False, pending_subagents, pending_swarms


def _is_child_of_owner(current_conv_id: str, owner_transcript: str) -> bool:
    if (
        not current_conv_id
        or current_conv_id == "unknown"
        or not owner_transcript
    ):
        return False
    tp = Path(owner_transcript)
    if not tp.is_file():
        return False
    pending_subagents = 0
    pending_swarms = 0
    try:
        with tp.open("r", encoding="utf-8", errors="ignore") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                if not _line_needs_spawn_parse(
                    line, current_conv_id, pending_subagents, pending_swarms
                ):
                    continue
                obj = _parse_jsonl_dict(line)
                if obj is None:
                    continue
                matched, pending_subagents, pending_swarms = _process_spawn_step(
                    obj, current_conv_id, pending_subagents, pending_swarms
                )
                if matched:
                    return True
    except OSError:
        return False
    return False


def _is_same_owner_tree(lock_data: LockDict, conv_id: str) -> bool:
    owner_id = str(lock_data.get("ownerId") or "")
    children = _coerce_str_list(lock_data.get("childIds"))
    if owner_id == conv_id or conv_id in children:
        return True
    return _is_child_of_owner(conv_id, str(lock_data.get("ownerTranscriptPath") or ""))


def _is_row_expired(row: sqlite3.Row, now: float, ttl_seconds: int) -> bool:
    res_until = _row_opt_float(row, "reserved_until")
    if res_until is not None:
        return now >= res_until
    last_active = _row_float(row, "last_active_at")
    return (now - last_active) > ttl_seconds


def _load_active_locks_map_tx(
    conn: sqlite3.Connection,
    now: float,
    ttl_seconds: int,
) -> dict[str, LockDict]:
    rows = conn.execute("SELECT * FROM locks ORDER BY module_key ASC").fetchall()
    active: dict[str, LockDict] = {}
    for row in rows:
        if not _is_row_expired(row, now, ttl_seconds):
            d = _row_to_lock_dict(row)
            active[str(d["moduleKey"])] = d
    return active


def _promote_next_for_module_tx(
    conn: sqlite3.Connection,
    module_key: str,
    now: float,
    ttl_seconds: int,
    meta_cache: dict[str, tuple[str, bool]],
) -> PromotionNotice | None:
    waiters = conn.execute(
        """
        SELECT * FROM lock_queue
        WHERE module_key = ? AND status = 'waiting'
        ORDER BY id ASC
        """,
        (module_key,),
    ).fetchall()
    if not waiters:
        return None

    active_locks = _load_active_locks_map_tx(conn, now, ttl_seconds)
    for row in waiters:
        req_group = _row_str(row, "request_group_id")
        waiter_id = _row_str(row, "waiter_conv_id")
        group_rows = conn.execute(
            """
            SELECT * FROM lock_queue
            WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'waiting'
            ORDER BY id ASC
            """,
            (req_group, waiter_id),
        ).fetchall()
        group_keys = [_row_str(gr, "module_key") for gr in group_rows] or [module_key]
        if any(
            gk in active_locks and not _is_same_owner_tree(active_locks[gk], waiter_id)
            for gk in group_keys
        ):
            continue

        waiter_proj = _row_str(row, "waiter_project_id")
        waiter_ws = _row_str(row, "waiter_workspace")
        session_kind = _row_str(row, "session_kind")
        reason_tag = _row_str(row, "reason_tag") or "edit"
        res_until = now + RESERVATION_TTL_SECONDS

        for gk in group_keys:
            if gk in active_locks:
                continue
            mod_root, is_shared = meta_cache.get(gk) or _infer_module_meta(
                gk, waiter_ws
            )
            tags = (
                [reason_tag, "reserved"]
                if reason_tag != "reserved"
                else ["reserved"]
            )
            _ = conn.execute(
                """
                INSERT OR REPLACE INTO locks (
                    module_key, module_root, is_shared, owner_id, owner_project_id,
                    owner_transcript, workspace, child_ids_json, tags_json,
                    acquired_at, last_active_at, reserved_until
                ) VALUES (?, ?, ?, ?, ?, '', ?, '[]', ?, ?, ?, ?)
                """,
                (
                    gk,
                    mod_root,
                    1 if is_shared else 0,
                    waiter_id,
                    waiter_proj,
                    waiter_ws,
                    json.dumps(tags, ensure_ascii=False),
                    now,
                    now,
                    res_until,
                ),
            )

        _ = conn.execute(
            """
            UPDATE lock_queue
            SET status = 'promoted', wake_status = 'pending', updated_at = ?
            WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'waiting'
            """,
            (now, req_group, waiter_id),
        )
        _log_event_tx(
            conn,
            "PROMOTED",
            ",".join(group_keys),
            waiter_id,
            f"group={req_group};reserved_until={res_until:.3f}",
        )
        return PromotionNotice(
            request_group_id=req_group,
            modules=tuple(group_keys),
            waiter_conv_id=waiter_id,
            waiter_project_id=waiter_proj,
            waiter_workspace=waiter_ws,
            session_kind=session_kind,
            reason_tag=reason_tag,
            reserved_until=res_until,
        )
    return None


def _expire_stale_and_promote_tx(
    conn: sqlite3.Connection,
    now: float,
    ttl_seconds: int,
) -> tuple[list[str], list[PromotionNotice]]:
    rows = conn.execute("SELECT * FROM locks ORDER BY module_key ASC").fetchall()
    expired_keys: list[str] = []
    meta_cache: dict[str, tuple[str, bool]] = {}

    for row in rows:
        if not _is_row_expired(row, now, ttl_seconds):
            continue
        mod_key = _row_str(row, "module_key")
        owner_id = _row_str(row, "owner_id")
        res_until = _row_opt_float(row, "reserved_until")
        meta_cache[mod_key] = (
            _row_str(row, "module_root"),
            bool(_row_int(row, "is_shared")),
        )

        if res_until is not None:
            _log_event_tx(
                conn,
                "RESERVATION_EXPIRED",
                mod_key,
                owner_id,
                f"reserved_until={res_until:.3f}",
            )
        else:
            idle_s = max(0.0, now - _row_float(row, "last_active_at"))
            _log_event_tx(conn, "TTL_EXPIRED", mod_key, owner_id, f"idle={idle_s:.1f}s")

        _ = conn.execute(
            "DELETE FROM lock_queue "
            "WHERE module_key = ? AND waiter_conv_id = ? AND status = 'promoted'",
            (mod_key, owner_id),
        )
        _ = conn.execute("DELETE FROM locks WHERE module_key = ?", (mod_key,))
        expired_keys.append(mod_key)

    promotions: list[PromotionNotice] = []
    seen_groups: set[tuple[str, str]] = set()
    for mod_key in expired_keys:
        promo = _promote_next_for_module_tx(conn, mod_key, now, ttl_seconds, meta_cache)
        if promo is not None:
            gkey = (promo.request_group_id, promo.waiter_conv_id)
            if gkey not in seen_groups:
                seen_groups.add(gkey)
                promotions.append(promo)
    return expired_keys, promotions


def _detect_wait_for_cycle_tx(
    conn: sqlite3.Connection,
    requester_conv_id: str,
    blocking_owners: set[str],
    active_locks: dict[str, LockDict],
) -> tuple[str, ...] | None:
    held_by_requester = [
        lk for lk in active_locks.values() if _is_same_owner_tree(lk, requester_conv_id)
    ]
    if not held_by_requester:
        return None

    requester_ids = {requester_conv_id} | {
        str(lk["ownerId"]) for lk in held_by_requester
    }
    waiting_rows = conn.execute(
        "SELECT waiter_conv_id, module_key FROM lock_queue WHERE status = 'waiting'"
    ).fetchall()
    adj: dict[str, set[str]] = {}
    for wrow in waiting_rows:
        waiter = _row_str(wrow, "waiter_conv_id")
        wmod = _row_str(wrow, "module_key")
        lock_row = active_locks.get(wmod)
        if lock_row is None or _is_same_owner_tree(lock_row, waiter):
            continue
        holder = str(lock_row["ownerId"])
        adj.setdefault(waiter, set()).add(holder)

    queue: deque[tuple[str, tuple[str, ...]]] = deque()
    visited: set[str] = set()
    for blocker in sorted(blocking_owners):
        queue.append((blocker, (requester_conv_id, blocker)))
        visited.add(blocker)

    while queue:
        node, path = queue.popleft()
        is_cycle_hit = node in requester_ids or any(
            _is_same_owner_tree(lk, node) for lk in held_by_requester
        )
        if is_cycle_hit:
            return path
        for nxt in sorted(adj.get(node, set())):
            if nxt not in visited:
                visited.add(nxt)
                queue.append((nxt, (*path, nxt)))
    return None


def _enqueue_group_tx(
    conn: sqlite3.Connection,
    targets: Sequence[tuple[ModuleTarget, str]],
    conv_id: str,
    ctx: SessionContext,
    now: float,
) -> tuple[str, int]:
    request_group_id = f"grp_{uuid.uuid4().hex[:12]}"
    primary_key = targets[0][0].key
    for target, tag in targets:
        _ = conn.execute(
            """
            INSERT INTO lock_queue (
                request_group_id, module_key, waiter_conv_id, waiter_project_id,
                waiter_workspace, session_kind, reason_tag, status, wake_status,
                retry_count, requested_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 'pending', 0, ?, ?)
            ON CONFLICT(module_key, waiter_conv_id) DO UPDATE SET
                request_group_id = excluded.request_group_id,
                waiter_project_id = CASE
                    WHEN excluded.waiter_project_id != ''
                    THEN excluded.waiter_project_id
                    ELSE lock_queue.waiter_project_id
                END,
                waiter_workspace = CASE
                    WHEN excluded.waiter_workspace != '' THEN excluded.waiter_workspace
                    ELSE lock_queue.waiter_workspace
                END,
                session_kind = excluded.session_kind,
                reason_tag = excluded.reason_tag,
                status = 'waiting',
                wake_status = 'pending',
                retry_count = CASE
                    WHEN lock_queue.status = 'waiting' THEN lock_queue.retry_count + 1
                    ELSE 0
                END,
                updated_at = excluded.updated_at
            """,
            (
                request_group_id,
                target.key,
                conv_id,
                ctx.project_id,
                ctx.workspace,
                ctx.session_kind,
                tag,
                now,
                now,
            ),
        )

    pos_row = conn.execute(
        """
        SELECT COUNT(*) AS cnt FROM lock_queue
        WHERE module_key = ? AND status = 'waiting' AND id <= (
            SELECT id FROM lock_queue WHERE module_key = ? AND waiter_conv_id = ?
        )
        """,
        (primary_key, primary_key, conv_id),
    ).fetchone()
    pos = _row_int(pos_row, "cnt") if pos_row is not None else 1
    _log_event_tx(
        conn,
        "QUEUED",
        ",".join(t.key for t, _ in targets),
        conv_id,
        f"group={request_group_id};pos={pos}",
    )
    return request_group_id, pos


@dataclass(frozen=True)
class _AcquireTxContext:
    conv_id: str
    session: SessionContext
    now: float


def _commit_single_lock_tx(
    conn: sqlite3.Connection,
    target: ModuleTarget,
    reason_tag: str,
    tx_ctx: _AcquireTxContext,
    existing: LockDict | None,
) -> LockDict | None:
    conv_id = tx_ctx.conv_id
    ctx = tx_ctx.session
    now = tx_ctx.now
    was_reserved = existing is not None and existing.get("reservedUntil") is not None
    if existing is not None and not was_reserved:
        owner_id = str(existing["ownerId"])
        children = _coerce_str_list(existing.get("childIds"))
        if owner_id != conv_id and conv_id not in children:
            children.append(conv_id)
        tags = [t for t in _coerce_str_list(existing.get("tags")) if t != "reserved"]
        if reason_tag not in tags:
            tags.append(reason_tag)
        proj_id = str(existing.get("ownerProjectId") or "") or ctx.project_id
        transcript = (
            str(existing.get("ownerTranscriptPath") or "") or ctx.transcript_path
        )
        workspace = str(existing.get("workspace") or "") or ctx.workspace
        _ = conn.execute(
            """
            UPDATE locks
            SET module_root = ?, is_shared = ?, owner_project_id = ?,
                owner_transcript = ?, workspace = ?, child_ids_json = ?,
                tags_json = ?, last_active_at = ?, reserved_until = NULL
            WHERE module_key = ?
            """,
            (
                str(target.root),
                1 if target.is_shared else 0,
                proj_id,
                transcript,
                workspace,
                json.dumps(children, ensure_ascii=False),
                json.dumps(tags, ensure_ascii=False),
                now,
                target.key,
            ),
        )
    else:
        _ = conn.execute(
            """
            INSERT OR REPLACE INTO locks (
                module_key, module_root, is_shared, owner_id, owner_project_id,
                owner_transcript, workspace, child_ids_json, tags_json,
                acquired_at, last_active_at, reserved_until
            ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, NULL)
            """,
            (
                target.key,
                str(target.root),
                1 if target.is_shared else 0,
                conv_id,
                ctx.project_id,
                ctx.transcript_path,
                ctx.workspace,
                json.dumps([reason_tag], ensure_ascii=False),
                now,
                now,
            ),
        )
        _log_event_tx(
            conn,
            "CLAIMED" if was_reserved else "ACQUIRED",
            target.key,
            conv_id,
            f"tag={reason_tag}",
        )

    _ = conn.execute(
        "DELETE FROM lock_queue WHERE module_key = ? AND waiter_conv_id = ?",
        (target.key, conv_id),
    )
    row = conn.execute(
        "SELECT * FROM locks WHERE module_key = ?", (target.key,)
    ).fetchone()
    return _row_to_lock_dict(row) if row is not None else None


def _dedupe_targets(
    targets: Sequence[tuple[ModuleTarget, str]],
) -> list[tuple[ModuleTarget, str]]:
    deduped: list[tuple[ModuleTarget, str]] = []
    seen_keys: set[str] = set()
    for target, tag in targets:
        if target.key not in seen_keys:
            seen_keys.add(target.key)
            deduped.append((target, tag))
    return deduped


@dataclass(frozen=True)
class _ConflictBundle:
    conflicts: list[LockDict]
    active_locks: dict[str, LockDict]
    expired_promos: list[PromotionNotice]
    enqueue_on_conflict: bool


def _handle_conflicts_tx(
    conn: sqlite3.Connection,
    deduped: Sequence[tuple[ModuleTarget, str]],
    tx_ctx: _AcquireTxContext,
    bundle: _ConflictBundle,
) -> AcquireResult:
    conv_id = tx_ctx.conv_id
    blocking_owners = {str(c["ownerId"]) for c in bundle.conflicts}
    cycle = _detect_wait_for_cycle_tx(
        conn, conv_id, blocking_owners, bundle.active_locks
    )
    if cycle is not None:
        _log_event_tx(
            conn,
            "DEADLOCK_RISK",
            ",".join(str(c["moduleKey"]) for c in bundle.conflicts),
            conv_id,
            f"chain={'->'.join(cycle[:MAX_CHAIN_PREVIEW])}",
        )
        return AcquireResult(
            acquired=False,
            status="DEADLOCK_RISK",
            conflicts=tuple(bundle.conflicts),
            deadlock_chain=cycle,
            expired_promotions=tuple(bundle.expired_promos),
        )

    req_group = ""
    pos = 0
    if bundle.enqueue_on_conflict:
        to_queue = [
            (t, tag)
            for t, tag in deduped
            if t.key not in bundle.active_locks
            or not _is_same_owner_tree(bundle.active_locks[t.key], conv_id)
            or bundle.active_locks[t.key].get("reservedUntil") is not None
        ] or list(deduped)
        req_group, pos = _enqueue_group_tx(
            conn, to_queue, conv_id, tx_ctx.session, tx_ctx.now
        )

    return AcquireResult(
        acquired=False,
        status="QUEUED",
        conflicts=tuple(bundle.conflicts),
        request_group_id=req_group,
        queue_position=pos,
        expired_promotions=tuple(bundle.expired_promos),
    )


def acquire_atomic_group(
    targets: Sequence[tuple[ModuleTarget, str]],
    conv_id: str,
    context: SessionContext | None = None,
    *,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    enqueue_on_conflict: bool = True,
    max_locks: int | None = None,
) -> AcquireResult:
    if not targets:
        return AcquireResult(acquired=True, status="ACQUIRED")

    deduped = _dedupe_targets(targets)
    tx_ctx = _AcquireTxContext(
        conv_id=conv_id,
        session=context or SessionContext(),
        now=time.time(),
    )

    with _db_conn() as conn, _write_tx(conn):
        _, expired_promos = _expire_stale_and_promote_tx(
            conn, tx_ctx.now, ttl_seconds
        )
        active_locks = _load_active_locks_map_tx(conn, tx_ctx.now, ttl_seconds)

        effective_max = (
            max_locks
            if max_locks is not None
            else _get_int_setting_tx(
                conn, "max_locks_per_session", DEFAULT_MAX_LOCKS_PER_SESSION
            )
        )
        owner_held_keys = {
            key
            for key, rec in active_locks.items()
            if _is_same_owner_tree(rec, conv_id)
        }
        requested_keys = {t.key for t, _ in deduped}
        new_keys = requested_keys - owner_held_keys
        projected_total = len(owner_held_keys | requested_keys)
        if new_keys and projected_total > effective_max:
            _log_event_tx(
                conn,
                "LIMIT_DENIED",
                ",".join(sorted(new_keys)),
                conv_id,
                (
                    f"held={len(owner_held_keys)};"
                    f"req={len(requested_keys)};"
                    f"projected={projected_total};"
                    f"limit={effective_max}"
                ),
            )
            return AcquireResult(
                acquired=False,
                status="LIMIT_EXCEEDED",
                held_modules=tuple(sorted(owner_held_keys)),
                limit=effective_max,
                expired_promotions=tuple(expired_promos),
            )

        conflicts = [
            active_locks[t.key]
            for t, _ in deduped
            if t.key in active_locks
            and not _is_same_owner_tree(active_locks[t.key], conv_id)
        ]
        if conflicts:
            return _handle_conflicts_tx(
                conn,
                deduped,
                tx_ctx,
                _ConflictBundle(
                    conflicts=conflicts,
                    active_locks=active_locks,
                    expired_promos=expired_promos,
                    enqueue_on_conflict=enqueue_on_conflict,
                ),
            )

        acquired: list[LockDict] = []
        for target, tag in deduped:
            rec = _commit_single_lock_tx(
                conn,
                target,
                tag,
                tx_ctx,
                active_locks.get(target.key),
            )
            if rec is not None:
                active_locks[target.key] = rec
                acquired.append(rec)

        return AcquireResult(
            acquired=True,
            status="ACQUIRED",
            locks=tuple(acquired),
            expired_promotions=tuple(expired_promos),
        )


def check_lock_conflict(
    target: ModuleTarget,
    conv_id: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> LockDict | None:
    now = time.time()
    with _db_conn() as conn, _write_tx(conn):
        _ = _expire_stale_and_promote_tx(conn, now, ttl_seconds)
        row = conn.execute(
            "SELECT * FROM locks WHERE module_key = ?", (target.key,)
        ).fetchone()
        if row is None:
            return None
        record = _row_to_lock_dict(row)
        if _is_same_owner_tree(record, conv_id):
            return None
        return record


def acquire_lock(
    target: ModuleTarget,
    conv_id: str,
    transcript_path: str = "",
    workspace: str = "",
    reason_tag: str = "edit",
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> tuple[bool, LockDict]:
    ctx = SessionContext(transcript_path=transcript_path, workspace=workspace)
    res = acquire_atomic_group(
        [(target, reason_tag)],
        conv_id,
        context=ctx,
        ttl_seconds=ttl_seconds,
        enqueue_on_conflict=False,
    )
    if res.acquired:
        return True, (res.locks[0] if res.locks else {})
    return False, (res.conflicts[0] if res.conflicts else {})


def release_owner_locks_with_promotions(
    conv_id: str,
    module_keys: Sequence[str] | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> ReleaseResult:
    now = time.time()
    wanted = {k.strip().lower() for k in module_keys if k.strip()} if module_keys else None
    with _db_conn() as conn, _write_tx(conn):
        _, expired_promos = _expire_stale_and_promote_tx(conn, now, ttl_seconds)
        rows = conn.execute(
            "SELECT * FROM locks WHERE owner_id = ? ORDER BY module_key ASC",
            (conv_id,),
        ).fetchall()
        released: list[LockDict] = []
        meta_cache: dict[str, tuple[str, bool]] = {}

        for row in rows:
            mod_key = _row_str(row, "module_key")
            if wanted is not None and mod_key.lower() not in wanted:
                continue
            meta_cache[mod_key] = (
                _row_str(row, "module_root"),
                bool(_row_int(row, "is_shared")),
            )
            released.append(_row_to_lock_dict(row))
            _ = conn.execute("DELETE FROM locks WHERE module_key = ?", (mod_key,))
            _ = conn.execute(
                "DELETE FROM lock_queue "
                "WHERE module_key = ? AND waiter_conv_id = ? AND status = 'promoted'",
                (mod_key, conv_id),
            )

        promotions = list(expired_promos)
        seen_groups = {(p.request_group_id, p.waiter_conv_id) for p in promotions}
        for rel_rec in released:
            mod_key = str(rel_rec["moduleKey"])
            promo = _promote_next_for_module_tx(
                conn, mod_key, now, ttl_seconds, meta_cache
            )
            if promo is not None:
                gkey = (promo.request_group_id, promo.waiter_conv_id)
                if gkey not in seen_groups:
                    seen_groups.add(gkey)
                    promotions.append(promo)

        if released:
            mod_names = [str(r["moduleKey"]) for r in released]
            _log_event_tx(conn, "RELEASE", ",".join(mod_names), conv_id, "")
            _append_history("RELEASE", conv_id, mod_names)
        return ReleaseResult(released=tuple(released), promotions=tuple(promotions))


def release_owner_locks(
    conv_id: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> list[LockDict]:
    return list(
        release_owner_locks_with_promotions(conv_id, ttl_seconds=ttl_seconds).released
    )


def list_active_locks(ttl_seconds: int = DEFAULT_TTL_SECONDS) -> list[LockDict]:
    now = time.time()
    with _db_conn() as conn, _write_tx(conn):
        _ = _expire_stale_and_promote_tx(conn, now, ttl_seconds)
        rows = conn.execute("SELECT * FROM locks ORDER BY module_key ASC").fetchall()
        return [_row_to_lock_dict(row) for row in rows]


def list_queue(
    module_key: str = "",
    statuses: Sequence[str] | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> list[QueueDict]:
    now = time.time()
    with _db_conn() as conn, _write_tx(conn):
        _ = _expire_stale_and_promote_tx(conn, now, ttl_seconds)
        rows = conn.execute("SELECT * FROM lock_queue ORDER BY id ASC").fetchall()
        allowed = set(statuses) if statuses is not None else {"waiting", "promoted"}
        waiting_ranks: dict[str, int] = {}
        result: list[QueueDict] = []
        for row in rows:
            st = _row_str(row, "status")
            mkey = _row_str(row, "module_key")
            pos = 0
            if st == "waiting":
                waiting_ranks[mkey] = waiting_ranks.get(mkey, 0) + 1
                pos = waiting_ranks[mkey]
            if st not in allowed:
                continue
            if module_key and mkey.lower() != module_key.lower():
                continue
            result.append(_row_to_queue_dict(row, position=pos))
        return result


def list_events(limit: int = 50) -> list[EventDict]:
    with _db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM lock_events ORDER BY id DESC LIMIT ?",
            (max(1, limit),),
        ).fetchall()
        return [
            {
                "id": _row_int(row, "id"),
                "ts": _row_float(row, "ts"),
                "event": _row_str(row, "event"),
                "moduleKey": _row_str(row, "module_key"),
                "convId": _row_str(row, "conv_id"),
                "detail": _row_str(row, "detail"),
            }
            for row in rows
        ]


def record_event(
    event: str,
    module_key: str = "",
    conv_id: str = "",
    detail: str = "",
) -> None:
    with _db_conn() as conn, _write_tx(conn):
        _log_event_tx(conn, event, module_key, conv_id, detail)


def mark_wake_status(
    request_group_id: str,
    waiter_conv_id: str,
    wake_status: str,
) -> None:
    if not request_group_id or not waiter_conv_id:
        return
    now = time.time()
    with _db_conn() as conn, _write_tx(conn):
        _ = conn.execute(
            """
            UPDATE lock_queue
            SET wake_status = ?, updated_at = ?
            WHERE request_group_id = ? AND waiter_conv_id = ?
            """,
            (wake_status, now, request_group_id, waiter_conv_id),
        )


def default_summary_db_paths() -> tuple[Path, ...]:
    gemini_dir = Path.home() / ".gemini"
    return (
        gemini_dir / "antigravity" / "conversation_summaries.db",
        gemini_dir / "antigravity-ide" / "conversation_summaries.db",
        gemini_dir / "antigravity-cli" / "conversation_summaries.db",
    )


def _extract_workspace_name(raw_ws: str) -> str:
    candidate = raw_ws.strip()
    if not candidate:
        return ""
    if candidate.startswith("["):
        with suppress(ValueError, TypeError):
            parsed: object = json.loads(candidate)
            if isinstance(parsed, list):
                items = cast("list[object]", parsed)
                first = next((str(x).strip() for x in items if str(x).strip()), "")
                candidate = first
    if not candidate:
        return ""
    if candidate.lower().startswith("file://"):
        parsed_uri = urlparse(candidate)
        path_str = unquote(parsed_uri.path)
        if os.name == "nt" and re.match(r"^/[A-Za-z]:", path_str):
            path_str = path_str[1:]
        candidate = path_str
    return Path(candidate).name or candidate


def _read_summary_db_rows(
    db_path: Path,
    target_ids: list[str],
    results: dict[str, dict[str, str]],
) -> None:
    if not target_ids or not db_path.is_file():
        return
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=1.0)
    except sqlite3.Error:
        return
    try:
        conn.row_factory = sqlite3.Row
        placeholders = ", ".join(["?"] * len(target_ids))
        query_head = (
            "SELECT conversation_id, title, workspace_uris "
            "FROM conversation_summaries WHERE conversation_id IN "
        )
        query = f"{query_head}({placeholders})"
        for row in conn.execute(query, target_ids).fetchall():
            cid = _row_str(row, "conversation_id")
            if not cid or cid in results:
                continue
            ws_name = _extract_workspace_name(_row_str(row, "workspace_uris"))
            results[cid] = {
                "title": _row_str(row, "title").strip(),
                "workspaceName": ws_name,
            }
    except sqlite3.Error:
        return
    finally:
        conn.close()


def lookup_conversation_summaries(
    conv_ids: Sequence[str],
    db_paths: Sequence[Path] | None = None,
) -> dict[str, dict[str, str]]:
    unique_ids: list[str] = []
    seen: set[str] = set()
    for cid in conv_ids:
        cleaned = cid.strip()
        if cleaned and cleaned != "unknown" and cleaned not in seen:
            seen.add(cleaned)
            unique_ids.append(cleaned)
    if not unique_ids:
        return {}

    candidates = tuple(db_paths) if db_paths is not None else default_summary_db_paths()
    results: dict[str, dict[str, str]] = {}
    for db_path in candidates:
        remaining = [cid for cid in unique_ids if cid not in results]
        if not remaining:
            break
        _read_summary_db_rows(db_path, remaining, results)
    return results


def _get_int_setting_tx(
    conn: sqlite3.Connection,
    key: str,
    default: int,
    minimum: int = 1,
) -> int:
    row = conn.execute(
        "SELECT value FROM lock_settings WHERE key = ?", (key,)
    ).fetchone()
    if row is None:
        return default
    try:
        parsed = int(_row_str(row, "value").strip())
    except ValueError:
        return default
    return parsed if parsed >= minimum else default


def get_guard_settings() -> GuardSettings:
    with _db_conn() as conn:
        return GuardSettings(
            max_locks_per_session=_get_int_setting_tx(
                conn, "max_locks_per_session", DEFAULT_MAX_LOCKS_PER_SESSION
            ),
            max_shared_deps_without_nodeps=_get_int_setting_tx(
                conn,
                "max_shared_deps_without_nodeps",
                DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS,
            ),
        )


def get_setting(key: str, default: str = "") -> str:
    with _db_conn() as conn:
        row = conn.execute(
            "SELECT value FROM lock_settings WHERE key = ?", (key,)
        ).fetchone()
        return _row_str(row, "value") if row is not None else default


def set_setting(key: str, value: str) -> None:
    with _db_conn() as conn, _write_tx(conn):
        _ = conn.execute(
            "INSERT OR REPLACE INTO lock_settings (key, value) VALUES (?, ?)",
            (key, value),
        )


def is_auto_wake_enabled() -> bool:
    return get_setting("auto_wake_enabled", "1") == "1"


def expire_stale_locks(
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> tuple[list[str], tuple[PromotionNotice, ...]]:
    now = time.time()
    with _db_conn() as conn, _write_tx(conn):
        expired_keys, promotions = _expire_stale_and_promote_tx(conn, now, ttl_seconds)
        return expired_keys, tuple(promotions)


def _unlock_matching_rows_tx(
    conn: sqlite3.Connection,
    module_key: str,
    owner_id: str,
) -> tuple[list[str], dict[str, tuple[str, bool]]]:
    removed: list[str] = []
    meta_cache: dict[str, tuple[str, bool]] = {}
    rows = conn.execute("SELECT * FROM locks ORDER BY module_key ASC").fetchall()
    for row in rows:
        key = _row_str(row, "module_key")
        row_owner = _row_str(row, "owner_id")
        match_mod = bool(module_key) and key.lower() == module_key.lower()
        match_owner = bool(owner_id) and row_owner.startswith(owner_id)
        if match_mod or match_owner:
            meta_cache[key] = (
                _row_str(row, "module_root"),
                bool(_row_int(row, "is_shared")),
            )
            _ = conn.execute("DELETE FROM locks WHERE module_key = ?", (key,))
            _ = conn.execute(
                "DELETE FROM lock_queue "
                "WHERE module_key = ? AND waiter_conv_id = ? AND status = 'promoted'",
                (key, row_owner),
            )
            removed.append(key)
    return removed, meta_cache


def unlock_locks_with_promotions(
    module_key: str = "",
    owner_id: str = "",
    expired_only: bool = False,
    unlock_all: bool = False,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> tuple[list[str], tuple[PromotionNotice, ...]]:
    now = time.time()
    with _db_conn() as conn, _write_tx(conn):
        if unlock_all:
            rows = conn.execute(
                "SELECT module_key FROM locks ORDER BY module_key ASC"
            ).fetchall()
            removed = [_row_str(r, "module_key") for r in rows]
            _ = conn.execute("DELETE FROM locks")
            _ = conn.execute("DELETE FROM lock_queue")
            _log_event_tx(
                conn, "MANUAL_UNLOCK_ALL", ",".join(removed), owner_id or "cli", ""
            )
            if removed:
                _append_history("MANUAL_UNLOCK", owner_id or "cli", removed)
            return removed, ()

        expired_keys, expired_promos = _expire_stale_and_promote_tx(
            conn, now, ttl_seconds
        )
        removed = list(expired_keys) if expired_only else []
        meta_cache: dict[str, tuple[str, bool]] = {}
        if not expired_only:
            removed, meta_cache = _unlock_matching_rows_tx(conn, module_key, owner_id)

        promotions = list(expired_promos)
        seen_groups = {(p.request_group_id, p.waiter_conv_id) for p in promotions}
        for key in removed:
            if key in expired_keys:
                continue
            promo = _promote_next_for_module_tx(conn, key, now, ttl_seconds, meta_cache)
            if promo is not None:
                gkey = (promo.request_group_id, promo.waiter_conv_id)
                if gkey not in seen_groups:
                    seen_groups.add(gkey)
                    promotions.append(promo)

        if removed:
            _log_event_tx(
                conn, "MANUAL_UNLOCK", ",".join(removed), owner_id or "cli", ""
            )
            _append_history("MANUAL_UNLOCK", owner_id or "cli", removed)
        return removed, tuple(promotions)


def unlock_locks(
    module_key: str = "",
    owner_id: str = "",
    expired_only: bool = False,
    unlock_all: bool = False,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> list[str]:
    removed, _ = unlock_locks_with_promotions(
        module_key=module_key,
        owner_id=owner_id,
        expired_only=expired_only,
        unlock_all=unlock_all,
        ttl_seconds=ttl_seconds,
    )
    return removed


def cancel_queue_entries(
    request_group_id: str = "",
    module_key: str = "",
    waiter_conv_id: str = "",
) -> int:
    clauses: list[str] = []
    params: list[str] = []
    if request_group_id:
        clauses.append("request_group_id = ?")
        params.append(request_group_id)
    if module_key:
        clauses.append("lower(module_key) = lower(?)")
        params.append(module_key)
    if waiter_conv_id:
        clauses.append("waiter_conv_id = ?")
        params.append(waiter_conv_id)
    if not clauses:
        return 0
    where_sql = " AND ".join(clauses)
    with _db_conn() as conn, _write_tx(conn):
        cur = conn.execute(f"DELETE FROM lock_queue WHERE {where_sql}", params)
        if cur.rowcount > 0:
            _log_event_tx(
                conn,
                "QUEUE_CANCELLED",
                module_key,
                waiter_conv_id,
                f"group={request_group_id}",
            )
        return cur.rowcount


def is_file_os_locked(file_path: Path) -> bool:
    if os.name != "nt" or not file_path.is_file():
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.CreateFileW(str(file_path), 0x40000000, 0, None, 3, 0x80, None)
    err = ctypes.get_last_error()
    invalid = ctypes.c_void_p(-1).value
    if handle is None or handle == invalid:
        return err == WIN_SHARING_VIOLATION
    kernel32.CloseHandle(handle)
    return False


def is_git_dirty(module_root: Path) -> bool:
    if not module_root.exists():
        return False
    git_exe = shutil.which("git")
    if not git_exe:
        return False
    proc = subprocess.run(
        [git_exe, "-C", str(module_root), "status", "--porcelain", "--", "."],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=GIT_TIMEOUT_SECONDS,
        check=False,
    )
    return proc.returncode == 0 and bool(proc.stdout.strip())


def _append_history(event: str, conv_id: str, modules: list[str]) -> None:
    try:
        lock_root = _effective_lock_root()
        lock_root.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"{ts}\t{event}\t{conv_id[:SHORT_ID_LEN]}\t{', '.join(modules)}\n"
        with open(_effective_history_log(), "a", encoding="utf-8") as fh:
            _ = fh.write(line)
    except OSError:
        pass
