#!/usr/bin/env python3
"""Install Antigravity governance & lock plugins into ~/.gemini/config/plugins."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

PLUGINS: tuple[str, ...] = (
    "project-lock",
    "dotnet-fast-execution",
    "rust-governance",
)

EXCLUDED_DIRS: frozenset[str] = frozenset(
    {
        "__pycache__",
        ".pytest_cache",
        "node_modules",
        ".git",
    }
)


def _ignore_filter(_dir: str, names: list[str]) -> set[str]:
    return {n for n in names if n in EXCLUDED_DIRS or n.endswith((".pyc", ".pyo"))}


def install_plugins(
    repo_root: Path,
    plugins_dir: Path,
    locks_config_path: Path,
    *,
    init_config: bool = False,
    dry_run: bool = False,
) -> list[Path]:
    """Copy plugin bundles into plugins_dir and optionally initialize locks config.json."""
    installed: list[Path] = []
    if not dry_run:
        plugins_dir.mkdir(parents=True, exist_ok=True)

    for name in PLUGINS:
        src = repo_root / "plugins" / name
        if not src.is_dir():
            raise FileNotFoundError(f"Plugin source directory missing: {src}")
        dst = plugins_dir / name
        installed.append(dst)
        if dry_run:
            print(f"[dry-run] install {src} -> {dst}")
            continue
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=_ignore_filter)
        print(f"[ok] installed {name} -> {dst}")

    example_cfg = repo_root / "examples" / "locks-config.example.json"
    if init_config and example_cfg.is_file():
        if locks_config_path.exists():
            print(f"[skip] keeping existing lock config: {locks_config_path}")
        elif dry_run:
            print(f"[dry-run] write {locks_config_path} from {example_cfg}")
        else:
            locks_config_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(example_cfg, locks_config_path)
            print(f"[ok] initialized {locks_config_path}")

    return installed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install Antigravity agent-plugins.")
    parser.add_argument(
        "--plugins-dir",
        type=Path,
        default=Path.home() / ".gemini" / "config" / "plugins",
        help="Target Antigravity plugins directory (default: ~/.gemini/config/plugins)",
    )
    parser.add_argument(
        "--init-config",
        action="store_true",
        help="Copy examples/locks-config.example.json to ~/.agents/locks/config.json if absent",
    )
    parser.add_argument(
        "--locks-config",
        type=Path,
        default=Path.home() / ".agents" / "locks" / "config.json",
        help="Target path for --init-config (default: ~/.agents/locks/config.json)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print actions without modifying files")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    install_plugins(
        repo_root,
        args.plugins_dir.expanduser(),
        args.locks_config.expanduser(),
        init_config=args.init_config,
        dry_run=args.dry_run,
    )
    print(
        "\nNext: enable plugins via Antigravity Plugins Manager UI or `/plugin` "
        "(do not hand-edit ~/.gemini/config/config.json)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
