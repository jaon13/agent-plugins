#!/usr/bin/env python3
"""Antigravity project-lock hook & CLI controller."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import cast

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from build_inspector import (
    collect_build_own_modules,
    collect_external_shared_dependencies,
    collect_mutating_module_targets,
    find_explicit_build_targets,
    has_no_dependencies_flag,
    is_dotnet_build_segment,
    is_read_only_command,
    is_read_only_segment,
    split_command_segments,
)
from lock_store import (
    DEFAULT_MAX_LOCKS_PER_SESSION,
    DEFAULT_TTL_SECONDS,
    SHORT_ID_LEN,
    AcquireResult,
    GuardSettings,
    LockDict,
    ModuleTarget,
    PromotionNotice,
    QueueDict,
    SessionContext,
    acquire_atomic_group,
    get_guard_settings,
    infer_module_target,
    is_auto_wake_enabled,
    is_file_os_locked,
    is_git_dirty,
    list_active_locks,
    list_events,
    list_queue,
    lookup_conversation_summaries,
    mark_wake_status,
    record_event,
    release_owner_locks_with_promotions,
    resolve_module_target,
    unlock_locks_with_promotions,
)

WAKE_TIMEOUT_SECONDS = 3.0
MAX_ERR_DETAIL_LEN = 120
RECENT_EVENT_LIMIT = 10
MAX_HELD_PREVIEW = 4


def _detect_session_kind(payload: dict[str, object], transcript: str) -> str:
    explicit = payload.get("sessionKind") or payload.get("session_kind")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower()
    low_tp = transcript.lower()
    has_cursor = (
        os.environ.get("CURSOR_TRACE_ID")
        or os.environ.get("CURSOR_SESSION_ID")
        or "cursor" in low_tp
    )
    if has_cursor:
        return "cursor"
    has_agy = (
        os.environ.get("ANTIGRAVITY_AGENTAPI_EXE")
        or os.environ.get("ANTIGRAVITY_LS_ADDRESS")
        or os.environ.get("ANTIGRAVITY_AGENT")
        or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
    )
    if has_agy:
        return "antigravity"
    return "external"


def _extract_session_context(
    payload: dict[str, object],
) -> tuple[str, SessionContext]:
    conv_id = str(
        payload.get("conversationId")
        or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
        or "unknown"
    )
    project_id = str(
        payload.get("projectId")
        or payload.get("ownerProjectId")
        or os.environ.get("ANTIGRAVITY_PROJECT_ID")
        or ""
    )
    transcript = str(payload.get("transcriptPath") or "")
    ws_raw = payload.get("workspacePaths")
    ws = ""
    if isinstance(ws_raw, list):
        ws_items = cast(list[object], ws_raw)
        if ws_items:
            ws = str(ws_items[0])
    ctx = SessionContext(
        project_id=project_id,
        transcript_path=transcript,
        workspace=ws,
        session_kind=_detect_session_kind(payload, transcript),
    )
    return conv_id, ctx


def _extract_tool_args(payload: dict[str, object]) -> dict[str, object]:
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return {}
    tc_map = cast(dict[str, object], tool_call)
    args = tc_map.get("args")
    if not isinstance(args, dict):
        return {}
    return cast(dict[str, object], args)


def _pick_primary_conflict(
    conflicts: Sequence[LockDict],
    hints_by_key: dict[str, str],
) -> tuple[LockDict, str]:
    for conflict in conflicts:
        key = str(conflict.get("moduleKey") or "")
        hint = hints_by_key.get(key, "")
        if hint:
            return conflict, hint
    first = conflicts[0]
    first_key = str(first.get("moduleKey") or "")
    return first, hints_by_key.get(first_key, "")


def _format_owner_display(holder: LockDict) -> tuple[str, str]:
    owner_full = str(holder.get("ownerId") or "")
    owner_short = owner_full[:SHORT_ID_LEN]
    summary = (
        lookup_conversation_summaries([owner_full]).get(owner_full, {})
        if owner_full
        else {}
    )
    ws = (
        Path(str(holder.get("workspace") or "")).name
        or summary.get("workspaceName", "")
        or "unknown"
    )
    title = summary.get("title", "")
    owner_label = f"{title} ({owner_short})" if title else owner_short
    return owner_label, ws


def _format_queued_deny(res: AcquireResult, hints_by_key: dict[str, str]) -> str:
    holder, extra_hint = _pick_primary_conflict(res.conflicts, hints_by_key)
    module_key = str(holder.get("moduleKey") or "")
    owner_label, ws = _format_owner_display(holder)
    raw_acq = holder.get("acquiredAt")
    acq_ts = float(raw_acq) if isinstance(raw_acq, int | float) else time.time()
    elapsed = int(max(0.0, time.time() - acq_ts))
    hint = f" {extra_hint}" if extra_hint else ""
    queue_info = ""
    if res.request_group_id:
        queue_info = (
            f" 대기열 #{res.queue_position} 등록됨(group={res.request_group_id});"
            " 점유 해제 시 60초 예약 후 자동 재개됩니다."
        )
    return json.dumps(
        {
            "decision": "deny",
            "reason": (
                f"[ProjectLock] 모듈 '{module_key}'이(가) 다른 활성 세션"
                f"({owner_label} @ {ws}, {elapsed}s 경과)에 의해 잠겨 있어 "
                f"차단되었습니다.{hint}{queue_info}"
                " (/project-lock 또는 "
                "[Lock & Tooling](sidecar://project-lock/lock_board/)"
                "에서 락/대기열 확인 가능)"
            ),
        },
        ensure_ascii=False,
    )


def _format_deadlock_deny(res: AcquireResult, hints_by_key: dict[str, str]) -> str:
    holder, extra_hint = _pick_primary_conflict(res.conflicts, hints_by_key)
    module_key = str(holder.get("moduleKey") or "")
    owner_label, ws = _format_owner_display(holder)
    chain = " -> ".join(c[:SHORT_ID_LEN] for c in res.deadlock_chain) or "cycle"
    hint = f" {extra_hint}" if extra_hint else ""
    return json.dumps(
        {
            "decision": "deny",
            "reason": (
                f"[ProjectLock] DEADLOCK_RISK: 모듈 '{module_key}' 점유 세션"
                f"({owner_label} @ {ws})이 현재 세션 보유 모듈을 대기 중입니다 "
                f"(순환: {chain}). 대기열에 등록하지 않고 즉시 차단했습니다.{hint}"
                " ([Lock & Tooling](sidecar://project-lock/lock_board/) 패널 확인)"
            ),
        },
        ensure_ascii=False,
    )


def _format_os_lock_deny(dll_path: Path) -> str:
    return json.dumps(
        {
            "decision": "deny",
            "reason": (
                f"[ProjectLock] '{dll_path.name}' 파일이 외부 프로세스"
                "(예: CodeXrayMcp)에 의해 잠겨 있어 전체 연쇄 빌드는 "
                "MSB3027로 실패합니다. 상위 .slnx 빌드 시 `--no-dependencies` "
                "(또는 `-p:BuildProjectReferences=false`) 옵션을 사용하세요."
            ),
        },
        ensure_ascii=False,
    )


def _format_limit_deny(res: AcquireResult) -> str:
    held_preview = ", ".join(res.held_modules[:MAX_HELD_PREVIEW])
    if len(res.held_modules) > MAX_HELD_PREVIEW:
        held_preview += f" 외 {len(res.held_modules) - MAX_HELD_PREVIEW}개"
    held_info = f" (현재 점유: {held_preview})" if held_preview else ""
    return json.dumps(
        {
            "decision": "deny",
            "reason": (
                "[ProjectLock] LIMIT_DENIED: 세션당 동시 모듈 락 상한"
                f"({len(res.held_modules)}/{res.limit})을 초과하여 대기열 등록 없이 "
                f"차단되었습니다.{held_info} 전체 솔루션(`.slnx`) 대신 수정한 "
                "`.csproj` 단위로 나누어 빌드하거나, 작업을 여러 턴 또는 "
                "`/swarm` 워커로 분할하세요. "
                "([Lock & Tooling](sidecar://project-lock/lock_board/) 패널 확인)"
            ),
        },
        ensure_ascii=False,
    )


def _format_dep_guard_deny(
    shared_deps: Sequence[ModuleTarget],
    dep_limit: int,
    max_locks: int,
) -> str:
    dep_preview = ", ".join(sorted(m.key for m in shared_deps)[:MAX_HELD_PREVIEW])
    if len(shared_deps) > MAX_HELD_PREVIEW:
        dep_preview += f" 외 {len(shared_deps) - MAX_HELD_PREVIEW}개"
    return json.dumps(
        {
            "decision": "deny",
            "reason": (
                "[ProjectLock] DEP_GUARD_DENIED: 외부 공유 모듈 "
                f"{len(shared_deps)}개({dep_preview})가 연쇄 빌드 대상에 포함되어 "
                f"임계치({dep_limit}개) 이상이므로 대기열 등록 없이 즉시 차단했습니다. "
                "`--no-dependencies` (또는 `-p:BuildProjectReferences=false` / "
                "`--no-build`) 옵션을 전달하거나, 공유 라이브러리를 "
                f"{max_locks}개 이하 모듈 배치로 분리해 먼저 빌드하세요. "
                "([Lock & Tooling](sidecar://project-lock/lock_board/) 패널 확인)"
            ),
        },
        ensure_ascii=False,
    )


def _extract_edit_path(args: dict[str, object]) -> str:
    for k in ("Path", "TargetFile", "path", "file_path", "TargetPath"):
        val = args.get(k)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _run_agentapi_wake(exe_path: Path, promo: PromotionNotice, msg: str) -> bool:
    mods_str = ",".join(promo.modules)
    cmd = (
        [
            sys.executable,
            str(exe_path),
            "agentapi",
            "send-message",
            promo.waiter_conv_id,
            msg,
        ]
        if exe_path.suffix.lower() == ".py"
        else [str(exe_path), "agentapi", "send-message", promo.waiter_conv_id, msg]
    )
    sub_env = os.environ.copy()
    if promo.waiter_project_id:
        sub_env["ANTIGRAVITY_PROJECT_ID"] = promo.waiter_project_id

    try:
        proc = subprocess.run(
            cmd,
            env=sub_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=WAKE_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        record_event("WAKE_FAILED", mods_str, promo.waiter_conv_id, "timeout=3s")
        return False
    except OSError as exc:
        record_event(
            "WAKE_FAILED",
            mods_str,
            promo.waiter_conv_id,
            f"oserror={type(exc).__name__}",
        )
        return False

    if proc.returncode == 0:
        record_event(
            "WAKE_SENT",
            mods_str,
            promo.waiter_conv_id,
            f"group={promo.request_group_id};project={promo.waiter_project_id}",
        )
        return True

    err_text = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")
    record_event(
        "WAKE_FAILED",
        mods_str,
        promo.waiter_conv_id,
        f"rc={proc.returncode};err={err_text[:MAX_ERR_DETAIL_LEN]}",
    )
    return False


def _resolve_wake_exe() -> tuple[Path | None, str]:
    configured = os.environ.get("ANTIGRAVITY_AGENTAPI_EXE", "").strip()
    if configured:
        cfg_path = Path(configured)
        if cfg_path.is_file():
            return cfg_path, ""
        return None, "ANTIGRAVITY_AGENTAPI_EXE not configured or missing"

    ls_addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS", "").strip()
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN", "").strip()
    if not ls_addr or not csrf:
        return None, "deferred"

    bin_dir = Path.home() / ".gemini" / "antigravity" / "bin"
    for name in ("agentapi.bat", "agentapi.cmd", "agentapi.exe", "agentapi"):
        candidate = bin_dir / name
        if candidate.is_file():
            return candidate, ""
    return None, "deferred"


def _wake_single_promotion(promo: PromotionNotice) -> str:
    mods_str = ",".join(promo.modules)
    if not promo.waiter_conv_id or promo.waiter_conv_id == "unknown":
        record_event(
            "WAKE_FAILED", mods_str, promo.waiter_conv_id, "missing waiter_conv_id"
        )
        mark_wake_status(promo.request_group_id, promo.waiter_conv_id, "failed")
        return "failed"
    if promo.session_kind == "cursor":
        record_event(
            "WAKE_FAILED",
            mods_str,
            promo.waiter_conv_id,
            "external cursor session; resume manually",
        )
        mark_wake_status(promo.request_group_id, promo.waiter_conv_id, "failed")
        return "failed"

    exe_path, err_kind = _resolve_wake_exe()
    if exe_path is None:
        if err_kind == "deferred":
            record_event(
                "WAKE_DEFERRED",
                mods_str,
                promo.waiter_conv_id,
                f"group={promo.request_group_id};awaiting sidecar wake",
            )
            mark_wake_status(promo.request_group_id, promo.waiter_conv_id, "pending")
            return "deferred"
        record_event("WAKE_FAILED", mods_str, promo.waiter_conv_id, err_kind)
        mark_wake_status(promo.request_group_id, promo.waiter_conv_id, "failed")
        return "failed"

    msg = (
        f"[ProjectLock] 대기 중이던 모듈({mods_str}) 락이 해제되어 60초 예약"
        f"(group={promo.request_group_id})으로 승계되었습니다. "
        "중단했던 작업을 재개하세요."
    )
    ok = _run_agentapi_wake(exe_path, promo, msg)
    mark_wake_status(
        promo.request_group_id,
        promo.waiter_conv_id,
        "sent" if ok else "failed",
    )
    return "sent" if ok else "failed"


def _wake_promotions(
    promotions: Sequence[PromotionNotice],
) -> list[tuple[PromotionNotice, str]]:
    if not promotions:
        return []
    if not is_auto_wake_enabled():
        for promo in promotions:
            mark_wake_status(promo.request_group_id, promo.waiter_conv_id, "disabled")
        return []
    results: list[tuple[PromotionNotice, str]] = []
    seen: set[tuple[str, str]] = set()
    for promo in promotions:
        key = (promo.request_group_id, promo.waiter_conv_id)
        if key in seen:
            continue
        seen.add(key)
        results.append((promo, _wake_single_promotion(promo)))
    return results


def _acquire_transactional(
    groups: list[tuple[list[ModuleTarget], str, str]],
    payload: dict[str, object],
    os_lock_dlls: list[Path] | None = None,
) -> str | None:
    for dll in os_lock_dlls or []:
        if is_file_os_locked(dll):
            return _format_os_lock_deny(dll)

    targets_with_tags: list[tuple[ModuleTarget, str]] = []
    hints_by_key: dict[str, str] = {}
    for targets, tag, hint in groups:
        for target in targets:
            targets_with_tags.append((target, tag))
            if hint and target.key not in hints_by_key:
                hints_by_key[target.key] = hint

    if not targets_with_tags:
        return None

    conv_id, ctx = _extract_session_context(payload)
    res = acquire_atomic_group(targets_with_tags, conv_id, context=ctx)
    if res.expired_promotions:
        _ = _wake_promotions(res.expired_promotions)

    if res.acquired:
        return None
    if res.status == "LIMIT_EXCEEDED":
        return _format_limit_deny(res)
    if res.status == "DEADLOCK_RISK":
        return _format_deadlock_deny(res, hints_by_key)
    return _format_queued_deny(res, hints_by_key)


def handle_pre_edit(payload: dict[str, object]) -> str:
    args = _extract_tool_args(payload)
    raw_path = _extract_edit_path(args)
    if not raw_path:
        return '{"decision":"allow"}'

    cwd = str(payload.get("cwd") or ".")
    target = resolve_module_target(raw_path, cwd)
    if target is None:
        return '{"decision":"allow"}'

    deny = _acquire_transactional([([target], "edit", "")], payload)
    return deny or '{"decision":"allow"}'


def _inspect_dotnet_build_segment(
    seg: str,
    cwd: Path,
    payload: dict[str, object],
    guard_cache: list[GuardSettings],
) -> tuple[
    list[tuple[list[ModuleTarget], str, str]],
    list[Path],
    str | None,
]:
    build_targets = find_explicit_build_targets(seg, cwd)
    own_mods = collect_build_own_modules(build_targets, cwd)
    seg_groups: list[tuple[list[ModuleTarget], str, str]] = []
    if own_mods:
        seg_groups.append((own_mods, "build", ""))
    if has_no_dependencies_flag(seg):
        return seg_groups, [], None

    own_keys = {m.key for m in own_mods}
    shared_deps, dll_candidates = collect_external_shared_dependencies(
        build_targets, own_keys
    )
    for dll in dll_candidates:
        if is_file_os_locked(dll):
            return seg_groups, dll_candidates, _format_os_lock_deny(dll)

    if not guard_cache:
        guard_cache.append(get_guard_settings())
    guard = guard_cache[0]
    if len(shared_deps) >= guard.max_shared_deps_without_nodeps:
        conv_id, _ = _extract_session_context(payload)
        record_event(
            "DEP_GUARD_DENIED",
            ",".join(sorted(m.key for m in shared_deps)),
            conv_id,
            (
                f"shared={len(shared_deps)};"
                f"limit={guard.max_shared_deps_without_nodeps}"
            ),
        )
        return (
            seg_groups,
            dll_candidates,
            _format_dep_guard_deny(
                shared_deps,
                guard.max_shared_deps_without_nodeps,
                guard.max_locks_per_session,
            ),
        )

    if shared_deps:
        dep_hint = (
            "공통 라이브러리 충돌을 피하려면 `--no-dependencies`로 빌드하세요."
        )
        seg_groups.append((shared_deps, "dep-build", dep_hint))
    return seg_groups, dll_candidates, None


def handle_pre_command(payload: dict[str, object]) -> str:
    args = _extract_tool_args(payload)
    cmd = str(args.get("CommandLine") or args.get("command") or "")
    if not cmd.strip() or is_read_only_command(cmd):
        return '{"decision":"allow"}'

    cwd = Path(str(payload.get("cwd") or ".")).resolve(strict=False)
    groups: list[tuple[list[ModuleTarget], str, str]] = []
    dll_checks: list[Path] = []
    guard_cache: list[GuardSettings] = []

    for seg in split_command_segments(cmd):
        if is_read_only_segment(seg):
            continue

        if is_dotnet_build_segment(seg):
            seg_groups, seg_dlls, immediate_deny = _inspect_dotnet_build_segment(
                seg, cwd, payload, guard_cache
            )
            if immediate_deny is not None:
                return immediate_deny
            groups.extend(seg_groups)
            dll_checks.extend(seg_dlls)
            continue

        mut_targets = collect_mutating_module_targets(seg, cwd)
        if mut_targets:
            groups.append((mut_targets, "cmd", ""))

    if not groups and not dll_checks:
        return '{"decision":"allow"}'

    deny = _acquire_transactional(groups, payload, os_lock_dlls=dll_checks)
    return deny or '{"decision":"allow"}'


def handle_session_start(payload: dict[str, object]) -> str:
    """Inject a user-only clickable Lock & Tooling pill at session start."""
    _ = payload
    return json.dumps(
        {
            "injectSteps": [
                {
                    "systemMessage": {
                        "systemMessage": "",
                        "metadata": {
                            "user_markdown": (
                                "🔒 [Lock & Tooling]"
                                "(sidecar://project-lock/lock_board/)"
                            ),
                        },
                    }
                }
            ]
        },
        ensure_ascii=False,
    )


def handle_stop(payload: dict[str, object]) -> str:
    if payload.get("fullyIdle") is False:
        return '{"decision":"stop"}'
    conv_id = str(
        payload.get("conversationId")
        or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
        or ""
    )
    if conv_id:
        rel = release_owner_locks_with_promotions(conv_id)
        if rel.promotions:
            _ = _wake_promotions(rel.promotions)
    return '{"decision":"stop"}'


def _collect_summary_map(
    locks: Sequence[LockDict],
    queue: Sequence[QueueDict],
    events: Sequence[dict[str, object]],
) -> dict[str, dict[str, str]]:
    conv_ids: list[str] = []
    for lk in locks:
        conv_ids.append(str(lk.get("ownerId") or ""))
    for item in queue:
        conv_ids.append(str(item.get("waiterConvId") or ""))
    for ev in events:
        conv_ids.append(str(ev.get("convId") or ""))
    return lookup_conversation_summaries(conv_ids)


def _pick_next_waiters_by_module(
    queue: Sequence[QueueDict],
    summaries: dict[str, dict[str, str]],
) -> tuple[dict[str, dict[str, object]], list[dict[str, object]]]:
    next_by_mod: dict[str, dict[str, object]] = {}
    for item in queue:
        mod_key = str(item.get("moduleKey") or "")
        st = str(item.get("status") or "")
        pos_raw = item.get("position")
        pos = int(pos_raw) if isinstance(pos_raw, int) else 0
        if st != "promoted" and not (st == "waiting" and pos == 1):
            continue
        existing = next_by_mod.get(mod_key)
        if existing is not None and str(existing.get("status") or "") == "promoted":
            continue
        cid = str(item.get("waiterConvId") or "")
        summary = summaries.get(cid, {})
        next_by_mod[mod_key] = {
            "id": item.get("id"),
            "moduleKey": mod_key,
            "waiterConvId": cid,
            "waiterTitle": summary.get("title", ""),
            "waiterWorkspaceName": summary.get("workspaceName", ""),
            "status": st,
            "wakeStatus": str(item.get("wakeStatus") or "pending"),
            "position": pos,
            "requestGroupId": str(item.get("requestGroupId") or ""),
        }
    return next_by_mod, list(next_by_mod.values())


def _enrich_payload_collections(
    locks: Sequence[LockDict],
    queue: Sequence[QueueDict],
    events: Sequence[dict[str, object]],
    *,
    max_locks_per_session: int = DEFAULT_MAX_LOCKS_PER_SESSION,
) -> tuple[
    list[LockDict],
    list[QueueDict],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    summaries = _collect_summary_map(locks, queue, events)
    next_by_mod, next_up = _pick_next_waiters_by_module(queue, summaries)

    owner_lock_counts: dict[str, int] = {}
    for lk in locks:
        oid = str(lk.get("ownerId") or "")
        if oid:
            owner_lock_counts[oid] = owner_lock_counts.get(oid, 0) + 1

    enriched_locks: list[LockDict] = []
    for lk in locks:
        copy_lk = dict(lk)
        owner_id = str(copy_lk.get("ownerId") or "")
        summary = summaries.get(owner_id, {})
        copy_lk["ownerTitle"] = summary.get("title", "")
        copy_lk["ownerWorkspaceName"] = summary.get("workspaceName", "")
        copy_lk["ownerLockCount"] = owner_lock_counts.get(owner_id, 1)
        copy_lk["maxLocksPerSession"] = max_locks_per_session
        mod_key = str(copy_lk.get("moduleKey") or "")
        copy_lk["nextWaiter"] = next_by_mod.get(mod_key)
        enriched_locks.append(copy_lk)

    enriched_queue: list[QueueDict] = []
    for item in queue:
        copy_item = dict(item)
        cid = str(copy_item.get("waiterConvId") or "")
        summary = summaries.get(cid, {})
        copy_item["waiterTitle"] = summary.get("title", "")
        copy_item["waiterWorkspaceName"] = summary.get("workspaceName", "")
        st = str(copy_item.get("status") or "")
        pos = copy_item.get("position")
        copy_item["isNextUp"] = st == "promoted" or (st == "waiting" and pos == 1)
        enriched_queue.append(copy_item)

    enriched_events: list[dict[str, object]] = []
    for ev in events:
        copy_ev = dict(ev)
        cid = str(copy_ev.get("convId") or "")
        copy_ev["convTitle"] = summaries.get(cid, {}).get("title", "")
        enriched_events.append(copy_ev)

    return enriched_locks, enriched_queue, enriched_events, next_up


def _format_lock_line(lk: LockDict, now: float) -> str:
    raw_last = lk.get("lastActiveAt")
    last_ts = float(raw_last) if isinstance(raw_last, int | float) else now
    age = int(max(0.0, now - last_ts))
    owner = str(lk.get("ownerId") or "")[:SHORT_ID_LEN]
    owner_title = str(lk.get("ownerTitle") or "")
    owner_disp = f"{owner} ({owner_title})" if owner_title else owner
    dirty = "dirty" if is_git_dirty(Path(str(lk.get("moduleRoot") or ""))) else "clean"
    raw_tags = lk.get("tags")
    tags = (
        ",".join(str(t) for t in cast(list[object], raw_tags))
        if isinstance(raw_tags, list)
        else ""
    )
    res_until = lk.get("reservedUntil")
    res_note = ""
    if isinstance(res_until, int | float):
        rem = int(max(0.0, float(res_until) - now))
        res_note = f" | reserved={rem}s"
    proj = str(lk.get("ownerProjectId") or "")
    proj_note = f" | proj={proj}" if proj else ""
    raw_cnt = lk.get("ownerLockCount")
    raw_cap = lk.get("maxLocksPerSession")
    quota_note = ""
    if (
        isinstance(raw_cnt, int)
        and isinstance(raw_cap, int)
        and raw_cap > 0
        and raw_cnt >= raw_cap
    ):
        quota_note = f" | ownerLocks={raw_cnt}/{raw_cap}"
    next_waiter = lk.get("nextWaiter")
    next_note = ""
    if isinstance(next_waiter, dict):
        nw = cast(dict[str, object], next_waiter)
        nw_title = str(nw.get("waiterTitle") or "")
        nw_short = str(nw.get("waiterConvId") or "")[:SHORT_ID_LEN]
        nw_label = f"{nw_title} ({nw_short})" if nw_title else nw_short
        next_note = f" | next={nw_label}"
    return (
        f"  - {lk.get('moduleKey')} | owner={owner_disp}"
        f" | idle={age}s/{DEFAULT_TTL_SECONDS}s"
        f"{quota_note}{res_note}{proj_note}{next_note}"
        f" | git={dirty} | tags=[{tags}]"
    )


def _print_enriched_locks(locks: Sequence[LockDict]) -> None:
    if not locks:
        print("Active project locks: 0")
        return
    now = time.time()
    print(f"Active project locks: {len(locks)}")
    for lk in locks:
        print(_format_lock_line(lk, now))


def cmd_status(as_json: bool = False) -> int:
    locks = list_active_locks()
    queue = list_queue()
    guard = get_guard_settings()
    enriched_locks, _, _, next_up = _enrich_payload_collections(
        locks,
        queue,
        [],
        max_locks_per_session=guard.max_locks_per_session,
    )
    if as_json:
        print(
            json.dumps(
                {
                    "maxLocksPerSession": guard.max_locks_per_session,
                    "maxSharedDepsWithoutNodeps": (
                        guard.max_shared_deps_without_nodeps
                    ),
                    "locks": enriched_locks,
                    "nextUp": next_up,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    _print_enriched_locks(enriched_locks)
    return 0


def _print_queue_items(queue: Sequence[QueueDict]) -> None:
    if not queue:
        print("Wait queue: 0")
        return
    print(f"Wait queue: {len(queue)}")
    for item in queue:
        waiter_full = str(item.get("waiterConvId") or "")
        waiter_short = waiter_full[:SHORT_ID_LEN]
        title = str(item.get("waiterTitle") or "")
        waiter_disp = f"{title} ({waiter_short})" if title else waiter_short
        kind = str(item.get("sessionKind") or "unknown")
        pos = item.get("position")
        status = str(item.get("status") or "")
        wake_st = str(item.get("wakeStatus") or "pending")
        is_next = bool(item.get("isNextUp"))
        next_tag = "[NEXT UP] " if is_next else ""
        grp = str(item.get("requestGroupId") or "")
        proj = str(item.get("waiterProjectId") or "")
        resume_hint = (
            f" | resume: agy --conversation {waiter_full} --continue"
            if kind in {"external", "cursor", "cli"} and waiter_full
            else ""
        )
        proj_note = f" | proj={proj}" if proj else ""
        print(
            f"  - {next_tag}#{pos} {item.get('moduleKey')} | "
            f"waiter={waiter_disp} ({kind}) "
            f"| status={status} | wake={wake_st} | group={grp}"
            f"{proj_note}{resume_hint}"
        )


def _print_recent_events(events: Sequence[dict[str, object]]) -> None:
    if not events:
        return
    print(f"Recent events ({len(events)}):")
    for ev in events:
        raw_ts = ev.get("ts")
        ts_val = float(raw_ts) if isinstance(raw_ts, int | float) else 0.0
        ts_str = time.strftime("%H:%M:%S", time.localtime(ts_val))
        conv_short = str(ev.get("convId") or "")[:SHORT_ID_LEN]
        conv_title = str(ev.get("convTitle") or "")
        conv_disp = f"{conv_title} ({conv_short})" if conv_title else conv_short
        detail = str(ev.get("detail") or "")
        detail_part = f" | {detail}" if detail else ""
        print(
            f"  - {ts_str} {ev.get('event')} | {ev.get('moduleKey')} "
            f"| {conv_disp}{detail_part}"
        )


def cmd_queue(as_json: bool = False) -> int:
    locks = list_active_locks()
    queue = list_queue()
    events = list_events(limit=RECENT_EVENT_LIMIT)
    auto_wake = is_auto_wake_enabled()
    guard = get_guard_settings()
    enriched_locks, enriched_queue, enriched_events, next_up = (
        _enrich_payload_collections(
            locks,
            queue,
            events,
            max_locks_per_session=guard.max_locks_per_session,
        )
    )
    if as_json:
        out = {
            "autoWakeEnabled": auto_wake,
            "maxLocksPerSession": guard.max_locks_per_session,
            "maxSharedDepsWithoutNodeps": guard.max_shared_deps_without_nodeps,
            "locks": enriched_locks,
            "queue": enriched_queue,
            "nextUp": next_up,
            "events": enriched_events,
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    _print_enriched_locks(enriched_locks)
    print(f"Auto-wake enabled: {'1' if auto_wake else '0'}")
    _print_queue_items(enriched_queue)
    _print_recent_events(enriched_events)
    return 0


def cmd_unlock(args: argparse.Namespace) -> int:
    removed, promotions = unlock_locks_with_promotions(
        module_key=str(args.module),
        owner_id=str(args.owner),
        expired_only=bool(args.expired),
        unlock_all=bool(args.all),
    )
    summary = ", ".join(removed) if removed else "(none)"
    print(f"Unlocked {len(removed)} lock(s): {summary}")
    if promotions:
        wake_results = _wake_promotions(promotions)
        for promo in promotions:
            mods = ", ".join(promo.modules)
            wake_note = next(
                (st for p, st in wake_results if p == promo),
                "disabled",
            )
            print(
                f"Promoted waiter {promo.waiter_conv_id[:SHORT_ID_LEN]} "
                f"for [{mods}] (60s reserved, wake={wake_note})"
            )
    return 0


def cmd_claim(args: argparse.Namespace) -> int:
    conv_id = str(args.conv_id).strip()
    if not conv_id:
        print("Error: --conv-id is required", file=sys.stderr)
        return 1
    ws = str(args.workspace or "").strip()
    fallback_cwd = Path(ws).resolve(strict=False) if ws else Path.cwd().resolve(strict=False)
    tag = str(args.tag or "swarm").strip() or "swarm"

    raw_specs = [s.strip() for s in str(args.modules or "").split(",") if s.strip()]
    targets: list[tuple[ModuleTarget, str]] = []
    for spec in raw_specs:
        mod = infer_module_target(spec, fallback_cwd=fallback_cwd)
        if mod is not None:
            targets.append((mod, tag))

    as_json = bool(args.json)
    if not targets:
        if as_json:
            print(json.dumps({"acquired": True, "status": "EXEMPT", "convId": conv_id, "locks": []}, ensure_ascii=False))
        else:
            print(f"Claimed 0 non-exempt module lock(s) for {conv_id[:SHORT_ID_LEN]}.")
        return 0

    ctx = SessionContext(
        project_id=str(args.project_id or "").strip(),
        transcript_path=str(args.owner_transcript or "").strip(),
        workspace=ws or str(targets[0][0].root),
        session_kind="swarm",
    )
    res = acquire_atomic_group(
        targets,
        conv_id,
        context=ctx,
        enqueue_on_conflict=False,
    )
    if res.expired_promotions:
        _ = _wake_promotions(res.expired_promotions)

    if as_json:
        payload = {
            "acquired": res.acquired,
            "status": res.status,
            "convId": conv_id,
            "locks": list(res.locks),
            "conflicts": list(res.conflicts),
            "heldModules": list(res.held_modules),
            "limit": res.limit,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif res.acquired:
        keys = ", ".join(str(lk.get("moduleKey") or "") for lk in res.locks)
        print(f"Claimed {len(res.locks)} lock(s) for {conv_id[:SHORT_ID_LEN]}: {keys}")
    else:
        print(f"Claim DENIED ({res.status}) for {conv_id[:SHORT_ID_LEN]}.")

    return 0 if res.acquired else 2


def cmd_release(args: argparse.Namespace) -> int:
    conv_id = str(args.conv_id).strip()
    if not conv_id:
        print("Error: --conv-id is required", file=sys.stderr)
        return 1
    raw_mods = [s.strip() for s in str(args.modules or "").split(",") if s.strip()]
    mod_keys: list[str] | None = None
    if raw_mods:
        resolved_keys: list[str] = []
        cwd = Path.cwd().resolve(strict=False)
        for item in raw_mods:
            mod = infer_module_target(item, fallback_cwd=cwd)
            resolved_keys.append(mod.key if mod is not None else item)
        mod_keys = resolved_keys

    rel = release_owner_locks_with_promotions(conv_id, module_keys=mod_keys)
    wake_results = _wake_promotions(rel.promotions) if rel.promotions else []
    released_keys = [str(r.get("moduleKey") or "") for r in rel.released]

    if bool(args.json):
        print(
            json.dumps(
                {
                    "convId": conv_id,
                    "released": released_keys,
                    "promotedCount": len(rel.promotions),
                    "wakeResults": [
                        {"waiterConvId": p.waiter_conv_id, "modules": list(p.modules), "wake": st}
                        for p, st in wake_results
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        summary = ", ".join(released_keys) if released_keys else "(none)"
        print(f"Released {len(released_keys)} lock(s) for {conv_id[:SHORT_ID_LEN]}: {summary}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Project-Unit Concurrency Lock Hook & CLI"
    )
    sub = parser.add_subparsers(dest="mode", required=True)
    _ = sub.add_parser("session-start")
    _ = sub.add_parser("pre-edit")
    _ = sub.add_parser("pre-command")
    _ = sub.add_parser("stop")
    st = sub.add_parser("status")
    _ = st.add_argument("--json", action="store_true")
    qu = sub.add_parser("queue")
    _ = qu.add_argument("--json", action="store_true")
    un = sub.add_parser("unlock")
    _ = un.add_argument("--module", default="")
    _ = un.add_argument("--owner", default="")
    _ = un.add_argument("--expired", action="store_true")
    _ = un.add_argument("--all", action="store_true")
    cl = sub.add_parser("claim")
    _ = cl.add_argument("--conv-id", required=True)
    _ = cl.add_argument("--modules", required=True)
    _ = cl.add_argument("--owner-transcript", default="")
    _ = cl.add_argument("--workspace", default="")
    _ = cl.add_argument("--project-id", default="")
    _ = cl.add_argument("--tag", default="swarm")
    _ = cl.add_argument("--json", action="store_true")
    rl = sub.add_parser("release")
    _ = rl.add_argument("--conv-id", required=True)
    _ = rl.add_argument("--modules", default="")
    _ = rl.add_argument("--json", action="store_true")
    return parser


def _fallback_hook_output(mode: str) -> str:
    if mode == "stop":
        return '{"decision":"stop"}'
    if mode == "session-start":
        return "{}"
    return '{"decision":"allow"}'


def _dispatch_hook_mode(mode: str, payload: dict[str, object]) -> str:
    if mode == "session-start":
        return handle_session_start(payload)
    if mode == "pre-edit":
        return handle_pre_edit(payload)
    if mode == "pre-command":
        return handle_pre_command(payload)
    return handle_stop(payload)


def main() -> int:
    reconf = getattr(sys.stdout, "reconfigure", None)
    if callable(reconf):
        reconf(encoding="utf-8")

    args = _build_parser().parse_args()
    mode = str(args.mode)
    if mode == "status":
        return cmd_status(as_json=bool(args.json))
    if mode == "queue":
        return cmd_queue(as_json=bool(args.json))
    if mode == "unlock":
        return cmd_unlock(args)
    if mode == "claim":
        return cmd_claim(args)
    if mode == "release":
        return cmd_release(args)

    raw = sys.stdin.read()
    if not raw.strip():
        print(
            handle_session_start({})
            if mode == "session-start"
            else _fallback_hook_output(mode)
        )
        return 0

    try:
        loaded: object = json.loads(raw)
        if not isinstance(loaded, dict):
            print(
                handle_session_start({})
                if mode == "session-start"
                else _fallback_hook_output(mode)
            )
            return 0
        payload = cast(dict[str, object], loaded)
        print(_dispatch_hook_mode(mode, payload))
    except (OSError, ValueError, TypeError, LookupError, RuntimeError, sqlite3.Error):
        print(_fallback_hook_output(mode))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
