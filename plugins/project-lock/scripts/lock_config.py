#!/usr/bin/env python3
"""Optional workspace group configuration loader for project-lock."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import cast

DEFAULT_IGNORED_SCRIPT_FRAGMENTS: tuple[str, ...] = (
    "01.codexray/scripts",
    "code-xray/scripts",
    "project-lock/scripts",
)


@dataclass(frozen=True)
class WorkspaceLockConfig:
    workspace_root: Path | None
    shared_src_groups: frozenset[str]
    shared_groups: frozenset[str]
    app_groups: frozenset[str]
    ignored_script_fragments: tuple[str, ...]
    os_lock_checks: tuple[tuple[str, str], ...]

    @property
    def all_shared_groups(self) -> frozenset[str]:
        return self.shared_src_groups | self.shared_groups


def _clean_str_list(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in cast(list[object], raw):
        s = str(item).strip()
        if s:
            out.append(s)
    return out


def resolve_config_path(lock_root: Path) -> Path:
    env_cfg = os.environ.get("PROJECT_LOCK_CONFIG", "").strip()
    if env_cfg:
        return Path(env_cfg).expanduser().resolve(strict=False)
    return (lock_root / "config.json").resolve(strict=False)


def load_workspace_config(lock_root: Path) -> WorkspaceLockConfig:
    cfg_path = resolve_config_path(lock_root)
    raw_data: dict[str, object] = {}
    if cfg_path.is_file():
        try:
            loaded: object = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
            if isinstance(loaded, dict):
                raw_data = cast(dict[str, object], loaded)
        except (OSError, json.JSONDecodeError):
            raw_data = {}

    env_ws = os.environ.get("PROJECT_LOCK_WORKSPACE_ROOT", "").strip()
    raw_ws = env_ws or str(raw_data.get("workspaceRoot") or "").strip()
    workspace_root = Path(raw_ws).expanduser().resolve(strict=False) if raw_ws else None

    shared_src = frozenset(s.lower() for s in _clean_str_list(raw_data.get("sharedSrcGroups")))
    shared_std = frozenset(s.lower() for s in _clean_str_list(raw_data.get("sharedGroups")))
    app_groups = frozenset(s.lower() for s in _clean_str_list(raw_data.get("appGroups")))

    frags = list(DEFAULT_IGNORED_SCRIPT_FRAGMENTS)
    for frag in _clean_str_list(raw_data.get("ignoredScriptFragments")):
        low = frag.replace("\\", "/").lower()
        if low not in frags:
            frags.append(low)

    checks: list[tuple[str, str]] = []
    raw_checks = raw_data.get("osLockChecks")
    if isinstance(raw_checks, list):
        for entry in cast(list[object], raw_checks):
            if not isinstance(entry, dict):
                continue
            em = cast(dict[str, object], entry)
            mod_key = str(em.get("moduleKey") or "").strip()
            dll_rel = str(em.get("dllRelPath") or "").strip()
            if mod_key and dll_rel:
                checks.append((mod_key, dll_rel))

    return WorkspaceLockConfig(
        workspace_root=workspace_root,
        shared_src_groups=shared_src,
        shared_groups=shared_std,
        app_groups=app_groups,
        ignored_script_fragments=tuple(frags),
        os_lock_checks=tuple(checks),
    )
