#!/usr/bin/env python3
"""Four-tier shell command access classifier for PreToolUse / PostToolUse guards."""

from __future__ import annotations

import re
import shlex
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from build_inspector import (
    collect_build_own_modules,
    collect_external_shared_dependencies,
    collect_mutating_module_targets,
    find_explicit_build_targets,
    has_no_dependencies_flag,
    is_dotnet_build_segment,
    is_read_only_segment,
)
from lock_store import (
    ModuleTarget,
    get_guard_settings,
    is_file_os_locked,
    resolve_module_target,
)

LockMode = Literal["FILE_WRITE", "TEST_SHARED", "BUILD_EXCL"]

DOTNET_VSTEST_RE = re.compile(r"\bdotnet\s+vstest\b", re.IGNORECASE)
DOTNET_TEST_RE = re.compile(r"\bdotnet\s+test\b", re.IGNORECASE)
NO_BUILD_FLAG_RE = re.compile(r"(?:^|\s)--no-build\b", re.IGNORECASE)
PYTEST_RE = re.compile(
    r"\bpytest(?:\.exe)?\b|\bpython(?:3|\.exe)?\b[^\n;|&]*\s-m\s+(?:pytest|unittest)\b",
    re.IGNORECASE,
)
NODE_TEST_RE = re.compile(
    r"\bnode(?:\.exe)?\b[^\n;|&]*\s--test\b|\b(?:vitest\s+run|jest)\b",
    re.IGNORECASE,
)
VERIFY_SCRIPT_RE = re.compile(
    r"\bverify_(?:dotnet|rust)\.py\b",
    re.IGNORECASE,
)
CARGO_BUILD_RE = re.compile(
    r"\bcargo\s+(?:build|test|check|clippy|fmt|run|install|publish|package)\b",
    re.IGNORECASE,
)
WEB_BUILD_RE = re.compile(
    r"\b(?:npm|pnpm|yarn|bun)\b[^\n;|&]*\b(?:build|vite\s+build)\b|\bvite\s+build\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ClaimRequestSpec:
    """Single resource claim derived from an edit or command segment."""

    target: ModuleTarget
    lock_mode: LockMode
    file_relpath: str = ""
    reason_tag: str = "edit"
    hint: str = ""


@dataclass(frozen=True)
class CommandClassification:
    """Classified claims and guard violations across a shell command invocation."""

    claims: tuple[ClaimRequestSpec, ...] = ()
    os_locked_dll: Path | None = None
    dep_guard_shared: tuple[ModuleTarget, ...] = ()
    dep_guard_limit: int = 0
    max_locks_limit: int = 0


def _tokenize(seg: str) -> list[str]:
    try:
        return shlex.split(seg, posix=False)
    except ValueError:
        return seg.split()


def _is_buildless_test_segment(seg: str) -> bool:
    if DOTNET_VSTEST_RE.search(seg):
        return True
    if DOTNET_TEST_RE.search(seg) and NO_BUILD_FLAG_RE.search(seg):
        return True
    if VERIFY_SCRIPT_RE.search(seg) and NO_BUILD_FLAG_RE.search(seg):
        return True
    return bool(PYTEST_RE.search(seg) or NODE_TEST_RE.search(seg))


def _resolve_test_targets(seg: str, cwd: Path) -> list[ModuleTarget]:
    if DOTNET_VSTEST_RE.search(seg) or DOTNET_TEST_RE.search(seg):
        build_targets = find_explicit_build_targets(seg, cwd)
        own = collect_build_own_modules(build_targets, cwd)
        if own:
            return own

    found: dict[str, ModuleTarget] = {}
    cwd_mod = resolve_module_target(cwd)
    if cwd_mod is not None:
        found[cwd_mod.key] = cwd_mod

    for tok in _tokenize(seg)[1:]:
        clean = tok.strip("\"'")
        if not clean or clean.startswith("-"):
            continue
        p = Path(clean)
        if not p.is_absolute():
            p = cwd / p
        if p.exists():
            mod = resolve_module_target(p, cwd)
            if mod is not None:
                found[mod.key] = mod
    return list(found.values())


def _is_compile_segment(seg: str) -> bool:
    if _is_buildless_test_segment(seg):
        return False
    return bool(
        is_dotnet_build_segment(seg)
        or CARGO_BUILD_RE.search(seg)
        or WEB_BUILD_RE.search(seg)
    )


def _classify_dotnet_build(
    seg: str,
    cwd: Path,
    os_lock_checker: Callable[[Path], bool],
) -> CommandClassification:
    build_targets = find_explicit_build_targets(seg, cwd)
    own_mods = collect_build_own_modules(build_targets, cwd)
    claims: list[ClaimRequestSpec] = [
        ClaimRequestSpec(target=m, lock_mode="BUILD_EXCL", reason_tag="build")
        for m in own_mods
    ]
    if has_no_dependencies_flag(seg):
        return CommandClassification(claims=tuple(claims))

    own_keys = {m.key for m in own_mods}
    shared_deps, dll_candidates = collect_external_shared_dependencies(
        build_targets, own_keys
    )
    for dll in dll_candidates:
        if os_lock_checker(dll):
            return CommandClassification(claims=tuple(claims), os_locked_dll=dll)

    guard = get_guard_settings()
    if len(shared_deps) >= guard.max_shared_deps_without_nodeps:
        return CommandClassification(
            claims=tuple(claims),
            dep_guard_shared=tuple(shared_deps),
            dep_guard_limit=guard.max_shared_deps_without_nodeps,
            max_locks_limit=guard.max_locks_per_session,
        )

    dep_hint = "공통 라이브러리 충돌을 피하려면 `--no-dependencies`로 빌드하세요."
    for dep in shared_deps:
        claims.append(
            ClaimRequestSpec(
                target=dep,
                lock_mode="BUILD_EXCL",
                reason_tag="dep-build",
                hint=dep_hint,
            )
        )
    return CommandClassification(claims=tuple(claims))


def classify_command_segment(
    seg: str,
    cwd: Path,
    *,
    os_lock_checker: Callable[[Path], bool] = is_file_os_locked,
) -> CommandClassification:
    """Classify one non-chained shell command segment into lock claim requests."""
    if is_read_only_segment(seg):
        return CommandClassification()

    if _is_buildless_test_segment(seg):
        targets = _resolve_test_targets(seg, cwd)
        return CommandClassification(
            claims=tuple(
                ClaimRequestSpec(target=t, lock_mode="TEST_SHARED", reason_tag="test")
                for t in targets
            )
        )

    if is_dotnet_build_segment(seg):
        return _classify_dotnet_build(seg, cwd, os_lock_checker)

    if _is_compile_segment(seg):
        targets = collect_mutating_module_targets(seg, cwd)
        return CommandClassification(
            claims=tuple(
                ClaimRequestSpec(target=t, lock_mode="BUILD_EXCL", reason_tag="build")
                for t in targets
            )
        )

    targets = collect_mutating_module_targets(seg, cwd)
    return CommandClassification(
        claims=tuple(
            ClaimRequestSpec(target=t, lock_mode="FILE_WRITE", reason_tag="cmd")
            for t in targets
        )
    )
