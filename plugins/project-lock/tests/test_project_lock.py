#!/usr/bin/env python3
"""Unit & multi-process concurrency tests for the project-lock SQLite WAL plugin."""

from __future__ import annotations

import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, closing, redirect_stdout
from pathlib import Path
from typing import cast
from unittest import mock

_HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = (
    _HERE if (_HERE / "lock_store.py").is_file() else _HERE.parent / "scripts"
)
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import build_inspector
import lock_store
import project_lock


def _parse_json_dict(raw: str) -> dict[str, object]:
    loaded: object = json.loads(raw)
    assert isinstance(loaded, dict)
    return cast(dict[str, object], loaded)


class ProjectLockTests(unittest.TestCase):
    base: Path
    fake_temp: Path
    lock_dir: Path
    fake_new: Path
    _tmp: tempfile.TemporaryDirectory[str]
    _stack: ExitStack

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name).resolve()
        self.fake_temp = (self.base / "sys_temp").resolve()
        self.fake_temp.mkdir(parents=True, exist_ok=True)
        self.lock_dir = (self.base / "locks").resolve()
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        self.fake_new = (self.base / "workspace").resolve()
        self.fake_new.mkdir(parents=True, exist_ok=True)
        self.config_path = self.lock_dir / "config.json"
        _ = self.config_path.write_text(
            json.dumps(
                {
                    "workspaceRoot": str(self.fake_new),
                    "sharedSrcGroups": ["00.sharedcore"],
                    "sharedGroups": ["02.libraries"],
                    "appGroups": [
                        "01.apps",
                        "03.utilities",
                        "04.webservices",
                        "05.tooling",
                    ],
                    "ignoredScriptFragments": ["05.tooling/01.codexray/scripts"],
                    "osLockChecks": [
                        {
                            "moduleKey": "00.SharedCore/Shared.Generators",
                            "dllRelPath": "Build/bin/Debug/Shared.Generators/netstandard2.0/Shared.Generators.dll",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        self._stack = ExitStack()
        _ = self._stack.enter_context(
            mock.patch.dict(
                os.environ,
                {
                    "TEMP": str(self.fake_temp),
                    "TMP": str(self.fake_temp),
                    "PROJECT_LOCK_DIR": str(self.lock_dir),
                    "PROJECT_LOCK_CONFIG": str(self.config_path),
                    "PROJECT_LOCK_WORKSPACE_ROOT": str(self.fake_new),
                    "ANTIGRAVITY_AGENTAPI_EXE": "",
                    "ANTIGRAVITY_LS_ADDRESS": "",
                    "ANTIGRAVITY_CSRF_TOKEN": "",
                    "ANTIGRAVITY_PROJECT_ID": "",
                },
            )
        )
        _ = self._stack.enter_context(
            mock.patch.object(lock_store, "LOCK_ROOT", self.lock_dir)
        )
        _ = self._stack.enter_context(
            mock.patch.object(lock_store, "LOCK_DB", self.lock_dir / "locks.db")
        )
        _ = self._stack.enter_context(
            mock.patch.object(
                lock_store, "HISTORY_LOG", self.lock_dir / "history.log"
            )
        )
        _ = self._stack.enter_context(
            mock.patch.object(lock_store, "NEW_ROOT", self.fake_new)
        )
        _ = self._stack.enter_context(
            mock.patch.object(project_lock, "is_file_os_locked", return_value=False)
        )

    def tearDown(self) -> None:
        self._stack.close()
        self._tmp.cleanup()

    def _make_dotnet_fixture(self) -> tuple[Path, Path, Path, Path]:
        common_ui = self.fake_new / "00.SharedCore" / "src" / "Shared.UI"
        common_gen = (
            self.fake_new / "00.SharedCore" / "src" / "Shared.Generators"
        )
        soft_help = self.fake_new / "02.Libraries" / "SupportKit"
        cm_dir = self.fake_new / "01.Apps" / "DesktopClient" / "src" / "DesktopClient.UI"
        for folder in (common_ui, common_gen, soft_help, cm_dir):
            folder.mkdir(parents=True, exist_ok=True)

        ui_csproj = common_ui / "Shared.UI.csproj"
        _ = ui_csproj.write_text(
            '<Project Sdk="Microsoft.NET.Sdk" />\n', encoding="utf-8"
        )

        gen_csproj = common_gen / "Shared.Generators.csproj"
        _ = gen_csproj.write_text(
            '<Project Sdk="Microsoft.NET.Sdk" />\n', encoding="utf-8"
        )

        help_csproj = soft_help / "SupportKit.csproj"
        _ = help_csproj.write_text(
            '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>'
            f'<ProjectReference Include="{ui_csproj}" />'
            "</ItemGroup></Project>\n",
            encoding="utf-8",
        )

        cm_csproj = cm_dir / "DesktopClient.UI.csproj"
        _ = cm_csproj.write_text(
            '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>'
            f'<ProjectReference Include="{ui_csproj}" />'
            f'<ProjectReference Include="{gen_csproj}" />'
            f'<ProjectReference Include="{help_csproj}" />'
            "</ItemGroup></Project>\n",
            encoding="utf-8",
        )

        cm_root = self.fake_new / "01.Apps" / "DesktopClient"
        cm_slnx = cm_root / "DesktopClient.slnx"
        _ = cm_slnx.write_text(
            "<Solution>\n"
            '  <Project Path="src/DesktopClient.UI/DesktopClient.UI.csproj" />\n'
            "</Solution>\n",
            encoding="utf-8",
        )

        common_root = self.fake_new / "00.SharedCore"
        common_slnx = common_root / "SharedCore.slnx"
        _ = common_slnx.write_text(
            "<Solution>\n"
            '  <Project Path="src/Shared.UI/Shared.UI.csproj" />\n'
            '  <Project Path="src/Shared.Generators/'
            'Shared.Generators.csproj" />\n'
            "</Solution>\n",
            encoding="utf-8",
        )
        return cm_slnx, common_slnx, ui_csproj, gen_csproj

    def _run_cli(
        self,
        args: list[str],
        *,
        stdin_obj: dict[str, object] | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PROJECT_LOCK_DIR"] = str(self.lock_dir)
        env["PROJECT_LOCK_CONFIG"] = str(self.config_path)
        env["PROJECT_LOCK_WORKSPACE_ROOT"] = str(self.fake_new)
        env["TEMP"] = str(self.fake_temp)
        env["TMP"] = str(self.fake_temp)
        if extra_env:
            env.update(extra_env)
        stdin_str = json.dumps(stdin_obj) if stdin_obj is not None else ""
        return subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "project_lock.py"), *args],
            input=stdin_str,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )

    def _write_mock_agentapi(self, mode: str = "ok") -> tuple[Path, Path]:
        log_file = self.base / "agentapi_calls.jsonl"
        script = self.base / "mock_agentapi.py"
        if mode == "fail":
            body = (
                "import sys\n"
                "sys.stderr.write('simulated wake failure\\n')\n"
                "raise SystemExit(2)\n"
            )
        elif mode == "slow":
            body = "import time\ntime.sleep(5)\n"
        else:
            body = (
                "import json, os, sys\n"
                f"log_path = {str(log_file)!r}\n"
                "rec = {\n"
                "    'argv': sys.argv[1:],\n"
                "    'project_id': os.environ.get('ANTIGRAVITY_PROJECT_ID', ''),\n"
                "}\n"
                "with open(log_path, 'a', encoding='utf-8') as fh:\n"
                "    fh.write(json.dumps(rec) + '\\n')\n"
            )
        _ = script.write_text(body, encoding="utf-8")
        return script, log_file

    def test_resolve_module_target_102_agenttooling_and_exemptions(self) -> None:
        m_ui = lock_store.resolve_module_target(
            self.fake_new / "00.SharedCore" / "src" / "Shared.UI" / "Button.xaml"
        )
        assert m_ui is not None
        self.assertEqual(m_ui.key, "00.SharedCore/Shared.UI")
        self.assertTrue(m_ui.is_shared)

        m_test = lock_store.resolve_module_target(
            self.fake_new / "00.SharedCore" / "tests" / "Shared.Core.Tests" / "A.cs"
        )
        assert m_test is not None
        self.assertEqual(m_test.key, "00.SharedCore/_root")
        self.assertTrue(m_test.is_shared)

        m_soft = lock_store.resolve_module_target(
            self.fake_new / "02.Libraries" / "SupportKit" / "HelpView.cs"
        )
        assert m_soft is not None
        self.assertEqual(m_soft.key, "02.Libraries/SupportKit")
        self.assertTrue(m_soft.is_shared)

        m_cm = lock_store.resolve_module_target(
            self.fake_new / "01.Apps" / "DesktopClient" / "src" / "DesktopClient.Core" / "A.cs"
        )
        assert m_cm is not None
        self.assertEqual(m_cm.key, "01.Apps/DesktopClient")
        self.assertFalse(m_cm.is_shared)

        m_cx = lock_store.resolve_module_target(
            self.fake_new / "05.Tooling" / "01.CodeXray" / "src" / "main.rs"
        )
        assert m_cx is not None
        self.assertEqual(m_cx.key, "05.Tooling/01.CodeXray")
        self.assertFalse(m_cx.is_shared)

        m_uia = lock_store.resolve_module_target(
            self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "src" / "Program.cs"
        )
        assert m_uia is not None
        self.assertEqual(m_uia.key, "05.Tooling/02.UiAutomationMcp")
        self.assertFalse(m_uia.is_shared)

        m_web = lock_store.resolve_module_target(
            self.fake_new / "04.WebServices" / "01.AdminPortal" / "backend" / "Cargo.toml"
        )
        assert m_web is not None
        self.assertEqual(m_web.key, "04.WebServices/01.AdminPortal")
        self.assertFalse(m_web.is_shared)

        self.assertIsNone(
            lock_store.resolve_module_target(Path.home() / ".gemini" / "config" / "x.md")
        )
        self.assertIsNone(
            lock_store.resolve_module_target(Path.home() / ".agents" / "AGENTS.md")
        )
        self.assertIsNone(
            lock_store.resolve_module_target(
                self.fake_new / "01.Apps" / "DesktopClient" / ".xray" / "index.db"
            )
        )
        self.assertIsNone(
            lock_store.resolve_module_target(self.fake_temp / "scratch.txt")
        )

    def test_sqlite_wal_schema_and_once_migration_from_legacy_json(self) -> None:
        now = time.time()
        active_json = self.lock_dir / lock_store.safe_lock_filename(
            "05.Tooling/01.CodeXray"
        )
        _ = active_json.write_text(
            json.dumps(
                {
                    "moduleKey": "05.Tooling/01.CodeXray",
                    "moduleRoot": str(self.fake_new / "05.Tooling" / "01.CodeXray"),
                    "isShared": False,
                    "ownerId": "legacy-owner-1",
                    "ownerTranscriptPath": "",
                    "workspace": "ws1",
                    "childIds": ["sub-1"],
                    "tags": ["edit"],
                    "acquiredAt": now - 30,
                    "lastActiveAt": now - 10,
                }
            ),
            encoding="utf-8",
        )
        expired_json = self.lock_dir / lock_store.safe_lock_filename(
            "03.Utilities/OldTool"
        )
        _ = expired_json.write_text(
            json.dumps(
                {
                    "moduleKey": "03.Utilities/OldTool",
                    "moduleRoot": str(self.fake_new / "03.Utilities" / "OldTool"),
                    "isShared": False,
                    "ownerId": "legacy-stale",
                    "acquiredAt": now - 5000,
                    "lastActiveAt": now - 5000,
                }
            ),
            encoding="utf-8",
        )
        corrupt_json = self.lock_dir / "broken.lock.json"
        _ = corrupt_json.write_text("{not-json", encoding="utf-8")

        active = lock_store.list_active_locks()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["moduleKey"], "05.Tooling/01.CodeXray")
        self.assertEqual(active[0]["ownerId"], "legacy-owner-1")
        self.assertEqual(active[0]["childIds"], ["sub-1"])
        self.assertFalse(active_json.exists())
        self.assertFalse(expired_json.exists())
        self.assertFalse(corrupt_json.exists())

        db_path = self.lock_dir / "locks.db"
        self.assertTrue(db_path.is_file())
        with closing(sqlite3.connect(str(db_path))) as conn:
            mode_row = conn.execute("PRAGMA journal_mode").fetchone()
            assert mode_row is not None
            self.assertEqual(str(mode_row[0]).lower(), "wal")
            tables = {
                str(r[0])
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            self.assertTrue(
                {"locks", "lock_queue", "lock_events", "lock_settings"} <= tables
            )

        self.assertTrue(lock_store.is_auto_wake_enabled())
        events = lock_store.list_events(limit=10)
        self.assertTrue(any(e["event"] == "MIGRATED" for e in events))

        # Migration runs only once on init
        second_json = self.lock_dir / lock_store.safe_lock_filename("00.SharedCore/Extra")
        _ = second_json.write_text(
            json.dumps(
                {
                    "moduleKey": "00.SharedCore/Extra",
                    "moduleRoot": "x",
                    "ownerId": "late-owner",
                    "acquiredAt": now,
                    "lastActiveAt": now,
                }
            ),
            encoding="utf-8",
        )
        _ = lock_store.init_db()
        keys = {str(lk["moduleKey"]) for lk in lock_store.list_active_locks()}
        self.assertNotIn("00.SharedCore/Extra", keys)

    def test_pre_edit_same_owner_conflict_lineage_ttl_and_stop(self) -> None:
        target_file = str(
            self.fake_new / "00.SharedCore" / "src" / "Shared.UI" / "Theme.xaml"
        )
        parent_transcript = self.base / "parent_transcript.jsonl"
        _ = parent_transcript.write_text(
            '{"type":"tool_call","child":"sub-conv-99"}\n', encoding="utf-8"
        )

        res1 = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-A",
                    "transcriptPath": str(parent_transcript),
                    "workspacePaths": [str(self.fake_new / "00.SharedCore")],
                    "toolCall": {"args": {"Path": target_file}},
                }
            )
        )
        self.assertEqual(res1["decision"], "allow")
        self.assertEqual(len(lock_store.list_active_locks()), 1)

        res2 = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-A",
                    "toolCall": {"args": {"TargetFile": target_file}},
                }
            )
        )
        self.assertEqual(res2["decision"], "allow")

        res_child = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "sub-conv-99",
                    "toolCall": {"args": {"Path": target_file}},
                }
            )
        )
        self.assertEqual(res_child["decision"], "allow")

        res_other = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-B",
                    "toolCall": {"args": {"Path": target_file}},
                }
            )
        )
        self.assertEqual(res_other["decision"], "deny")
        self.assertIn("00.SharedCore/Shared.UI", str(res_other["reason"]))
        self.assertEqual(len(lock_store.list_queue()), 1)

        stop_busy = _parse_json_dict(
            project_lock.handle_stop({"conversationId": "conv-A", "fullyIdle": False})
        )
        self.assertEqual(stop_busy["decision"], "stop")
        self.assertEqual(len(lock_store.list_active_locks()), 1)

        # Release promotes conv-B; clear queue for clean TTL test below
        stop_idle = _parse_json_dict(
            project_lock.handle_stop({"conversationId": "conv-A", "fullyIdle": True})
        )
        self.assertEqual(stop_idle["decision"], "stop")
        _ = lock_store.unlock_locks(unlock_all=True)
        self.assertEqual(len(lock_store.list_active_locks()), 0)

        mod_ui = lock_store.resolve_module_target(target_file)
        assert mod_ui is not None
        ok, _ = lock_store.acquire_lock(mod_ui, "conv-stale")
        self.assertTrue(ok)
        stale_ts = time.time() - (lock_store.DEFAULT_TTL_SECONDS + 30)
        with closing(sqlite3.connect(str(self.lock_dir / "locks.db"))) as conn:
            _ = conn.execute(
                "UPDATE locks SET last_active_at = ? WHERE module_key = ?",
                (stale_ts, mod_ui.key),
            )
            conn.commit()

        res_takeover = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-fresh",
                    "toolCall": {"args": {"Path": target_file}},
                }
            )
        )
        self.assertEqual(res_takeover["decision"], "allow")

    def test_pre_command_read_only_and_dotnet_guards(self) -> None:
        cm_slnx, common_slnx, ui_csproj, _ = self._make_dotnet_fixture()
        cm_cwd = str(cm_slnx.parent)

        res_git = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-ro",
                    "cwd": cm_cwd,
                    "toolCall": {"args": {"CommandLine": f'git -C "{cm_cwd}" status 2>$null'}},
                }
            )
        )
        self.assertEqual(res_git["decision"], "allow")
        self.assertEqual(lock_store.list_active_locks(), [])

        ui_mod = lock_store.resolve_module_target(ui_csproj)
        assert ui_mod is not None
        _ = lock_store.acquire_lock(ui_mod, "conv-other")

        res_blocked = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-cm",
                    "cwd": cm_cwd,
                    "toolCall": {"args": {"CommandLine": "dotnet build DesktopClient.slnx -c Debug"}},
                }
            )
        )
        self.assertEqual(res_blocked["decision"], "deny")
        self.assertIn("--no-dependencies", str(res_blocked["reason"]))
        self.assertEqual(
            [str(lk["moduleKey"]) for lk in lock_store.list_active_locks()],
            ["00.SharedCore/Shared.UI"],
        )

        # Clear conv-cm's queued group so we can test vstest next
        _ = lock_store.cancel_queue_entries(waiter_conv_id="conv-cm")
        res_vstest = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-cm",
                    "cwd": cm_cwd,
                    "toolCall": {
                        "args": {"CommandLine": r"dotnet vstest bin\Debug\DesktopClient.Core.Tests.dll"}
                    },
                }
            )
        )
        self.assertEqual(res_vstest["decision"], "allow")
        self.assertEqual(
            {str(lk["moduleKey"]) for lk in lock_store.list_active_locks()},
            {"00.SharedCore/Shared.UI", "01.Apps/DesktopClient"},
        )

        with mock.patch.object(project_lock, "is_file_os_locked", return_value=True):
            for cmd in (
                "dotnet build DesktopClient.slnx -c Debug --no-dependencies",
                "dotnet test DesktopClient.slnx --no-build",
                "python verify_dotnet.py --repo-root . --no-build",
                r"powershell -File .\installer\build_installer.ps1 -SkipPublish",
            ):
                res = _parse_json_dict(
                    project_lock.handle_pre_command(
                        {
                            "conversationId": "conv-cm",
                            "cwd": cm_cwd,
                            "toolCall": {"args": {"CommandLine": cmd}},
                        }
                    )
                )
                self.assertEqual(res["decision"], "allow", f"Failed on {cmd}")

        _ = lock_store.unlock_locks(unlock_all=True)
        with mock.patch.object(project_lock, "is_file_os_locked", return_value=True):
            res_os_lock = _parse_json_dict(
                project_lock.handle_pre_command(
                    {
                        "conversationId": "conv-cm2",
                        "cwd": cm_cwd,
                        "toolCall": {"args": {"CommandLine": "dotnet build DesktopClient.slnx"}},
                    }
                )
            )
        self.assertEqual(res_os_lock["decision"], "deny")
        self.assertIn("Shared.Generators.dll", str(res_os_lock["reason"]))
        self.assertEqual(lock_store.list_active_locks(), [])
        self.assertEqual(lock_store.list_queue(), [])

        res_common = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-common",
                    "cwd": str(common_slnx.parent),
                    "toolCall": {"args": {"CommandLine": "dotnet build SharedCore.slnx --no-restore"}},
                }
            )
        )
        self.assertEqual(res_common["decision"], "allow")
        common_keys = {str(lk["moduleKey"]) for lk in lock_store.list_active_locks()}
        self.assertEqual(
            common_keys,
            {
                "00.SharedCore/_root",
                "00.SharedCore/Shared.UI",
                "00.SharedCore/Shared.Generators",
            },
        )

    def test_pre_command_static_analysis_and_xray_grep_exemptions(self) -> None:
        cm_slnx, _, ui_csproj, _ = self._make_dotnet_fixture()
        cm_cwd = str(cm_slnx.parent)
        ui_mod = lock_store.resolve_module_target(ui_csproj)
        assert ui_mod is not None
        _ = lock_store.acquire_lock(ui_mod, "conv-other")

        read_only_cmds = [
            f'rg -n "ErrorLog" "{cm_cwd}\\verify_dotnet.py"',
            "xray-grep -p Foo src",
            r"D:\Workspace\05.Tooling\01.CodeXray\bin\xray-grep.exe --regex -p Bar",
            r"D:\Workspace\05.Tooling\01.CodeXray\bin\structural-clone.exe -p src",
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/codebase_map.py" --repo-root .',
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/xaml_style_xray.py" --repo-root .',
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/polyglot_xray.py" --repo-root .',
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/dotnet_xray.py" --repo-root .',
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/grep_review.py" list',
            'python "/opt/tools/.agents/bin/xray_run.py" xray-grep -p Baz',
            'python "/opt/tools/.agents/bin/xray_run.py" check_consistency.py --repo-root .',
            "python project_lock.py queue",
            'python project_lock.py claim --conv-id swarm-w1 --modules "05.Tooling/01.CodeXray"',
            "ruff check scripts/sample_qa.py",
            "basedpyright scripts/sample_qa.py",
            "ast-grep scan src",
            'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" } | Select-Object ProcessId',
            'Get-Process | Sort-Object Id | Format-Table -AutoSize',
            f'Test-Path "{cm_cwd}"',
        ]
        for cmd in read_only_cmds:
            res = _parse_json_dict(
                project_lock.handle_pre_command(
                    {
                        "conversationId": "conv-cm",
                        "cwd": cm_cwd,
                        "toolCall": {"args": {"CommandLine": cmd}},
                    }
                )
            )
            self.assertEqual(res["decision"], "allow", f"Expected allow for: {cmd}")
            self.assertEqual(
                [str(lk["moduleKey"]) for lk in lock_store.list_active_locks()],
                ["00.SharedCore/Shared.UI"],
                f"Expected zero new locks for: {cmd}",
            )

        mut_cmds = [
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/verify_dotnet.py" --repo-root .',
            'python "$HOME/.agents/bin/xray_run.py" dotnet_xray.py --repo-root . --build',
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/grep_review.py" --apply',
        ]
        res_verify_blocked = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-cm",
                    "cwd": cm_cwd,
                    "toolCall": {"args": {"CommandLine": mut_cmds[0]}},
                }
            )
        )
        self.assertEqual(res_verify_blocked["decision"], "deny")

        for mut_cmd in (
            'python "D:/Workspace/05.Tooling/01.CodeXray/scripts/polyglot_xray.py" --repo-root . --build',
            "ruff check --fix docs/SQA/launch_cm_uia_qa.py",
        ):
            res = _parse_json_dict(
                project_lock.handle_pre_command(
                    {
                        "conversationId": "conv-cm",
                        "cwd": cm_cwd,
                        "toolCall": {"args": {"CommandLine": mut_cmd}},
                    }
                )
            )
            self.assertEqual(res["decision"], "allow", f"Failed on {mut_cmd}")

        self.assertFalse(build_inspector.is_read_only_segment(mut_cmds[1]))
        self.assertFalse(build_inspector.is_read_only_segment(mut_cmds[2]))
        self.assertFalse(
            build_inspector.is_read_only_segment(
                "Get-CimInstance Win32_Process | Invoke-CimMethod -MethodName Terminate"
            )
        )
        self.assertFalse(
            build_inspector.is_read_only_segment(
                "Get-Process notepad | Stop-Process"
            )
        )

    def test_atomic_multi_module_queue_group_no_partial_locks(self) -> None:
        cm_slnx, _, ui_csproj, _ = self._make_dotnet_fixture()
        cm_cwd = str(cm_slnx.parent)
        ui_mod = lock_store.resolve_module_target(ui_csproj)
        assert ui_mod is not None
        _ = lock_store.acquire_lock(ui_mod, "conv-holder")
        # Fixture DesktopClient.slnx has 3 shared deps; raise dep guard to 4 to test atomic 4-module queueing.
        lock_store.set_setting("max_shared_deps_without_nodeps", "4")

        with mock.patch.dict(
            os.environ,
            {"ANTIGRAVITY_PROJECT_ID": "proj-cm", "ANTIGRAVITY_AGENT": "1"},
        ):
            res = _parse_json_dict(
                project_lock.handle_pre_command(
                    {
                        "conversationId": "conv-waiter",
                        "cwd": cm_cwd,
                        "toolCall": {"args": {"CommandLine": "dotnet build DesktopClient.slnx"}},
                    }
                )
            )
        self.assertEqual(res["decision"], "deny")

        # Must hold ZERO partial locks on DesktopClient or Shared.Generators
        active_keys = [str(lk["moduleKey"]) for lk in lock_store.list_active_locks()]
        self.assertEqual(active_keys, ["00.SharedCore/Shared.UI"])

        # All 4 requested modules queued under ONE requestGroupId
        q_rows = lock_store.list_queue()
        self.assertEqual(len(q_rows), 4)
        groups = {str(r["requestGroupId"]) for r in q_rows}
        self.assertEqual(len(groups), 1)
        expected_mods = {
            "01.Apps/DesktopClient",
            "00.SharedCore/Shared.UI",
            "00.SharedCore/Shared.Generators",
            "02.Libraries/SupportKit",
        }
        self.assertEqual({str(r["moduleKey"]) for r in q_rows}, expected_mods)
        self.assertTrue(all(r["waiterProjectId"] == "proj-cm" for r in q_rows))
        self.assertTrue(all(r["sessionKind"] == "antigravity" for r in q_rows))

        # Another session CAN still lock DesktopClient because conv-waiter did NOT hold a partial lock
        res_other = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-free",
                    "toolCall": {
                        "args": {
                            "Path": str(
                                self.fake_new
                                / "01.Apps"
                                / "DesktopClient"
                                / "src"
                                / "DesktopClient.UI"
                                / "Main.cs"
                            )
                        }
                    },
                }
            )
        )
        self.assertEqual(res_other["decision"], "allow")

        # Releasing Shared.UI while DesktopClient is still held by conv-free does NOT prematurely promote conv-waiter
        rel1 = lock_store.release_owner_locks_with_promotions("conv-holder")
        self.assertEqual(rel1.promotions, ())

        # Once conv-free also releases DesktopClient, conv-waiter gets promoted for ALL 4 modules atomically!
        rel2 = lock_store.release_owner_locks_with_promotions("conv-free")
        self.assertEqual(len(rel2.promotions), 1)
        self.assertEqual(set(rel2.promotions[0].modules), expected_mods)
        reserved_locks = lock_store.list_active_locks()
        self.assertEqual(len(reserved_locks), 4)
        self.assertTrue(all(lk["ownerId"] == "conv-waiter" for lk in reserved_locks))
        self.assertTrue(all(lk["reservedUntil"] is not None for lk in reserved_locks))

    def test_wait_for_graph_cycle_detection_deadlock_risk(self) -> None:
        m1_file = str(self.fake_new / "05.Tooling" / "01.CodeXray" / "a.rs")
        m2_file = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "b.cs")
        m3_file = str(self.fake_new / "02.Libraries" / "SupportKit" / "c.cs")

        # 2-node cycle: A holds M1, B holds M2, B waits on M1, A requests M2 -> DEADLOCK_RISK
        self.assertEqual(
            _parse_json_dict(
                project_lock.handle_pre_edit(
                    {
                        "conversationId": "conv-A",
                        "toolCall": {"args": {"Path": m1_file}},
                    }
                )
            )["decision"],
            "allow",
        )
        self.assertEqual(
            _parse_json_dict(
                project_lock.handle_pre_edit(
                    {
                        "conversationId": "conv-B",
                        "toolCall": {"args": {"Path": m2_file}},
                    }
                )
            )["decision"],
            "allow",
        )
        res_b_wait = _parse_json_dict(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-B", "toolCall": {"args": {"Path": m1_file}}}
            )
        )
        self.assertEqual(res_b_wait["decision"], "deny")
        self.assertNotIn("DEADLOCK_RISK", str(res_b_wait["reason"]))

        res_a_cycle = _parse_json_dict(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-A", "toolCall": {"args": {"Path": m2_file}}}
            )
        )
        self.assertEqual(res_a_cycle["decision"], "deny")
        self.assertIn("DEADLOCK_RISK", str(res_a_cycle["reason"]))
        # Must NOT enqueue conv-A into cycle
        self.assertEqual(
            [str(q["waiterConvId"]) for q in lock_store.list_queue()],
            ["conv-B"],
        )
        self.assertTrue(
            any(e["event"] == "DEADLOCK_RISK" for e in lock_store.list_events(10))
        )

        # 3-node cycle: A->M1, B->M2, C->M3; B waits M1, C waits M2, A requests M3 -> DEADLOCK_RISK
        _ = lock_store.unlock_locks(unlock_all=True)
        for cid, fpath in (("conv-A", m1_file), ("conv-B", m2_file), ("conv-C", m3_file)):
            self.assertEqual(
                _parse_json_dict(
                    project_lock.handle_pre_edit(
                        {"conversationId": cid, "toolCall": {"args": {"Path": fpath}}}
                    )
                )["decision"],
                "allow",
            )
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-B", "toolCall": {"args": {"Path": m1_file}}}
        )
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-C", "toolCall": {"args": {"Path": m2_file}}}
        )
        res_3way = _parse_json_dict(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-A", "toolCall": {"args": {"Path": m3_file}}}
            )
        )
        self.assertEqual(res_3way["decision"], "deny")
        self.assertIn("DEADLOCK_RISK", str(res_3way["reason"]))

    def test_60s_reserved_token_anti_steal_and_auto_expire_promote_second(self) -> None:
        target = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "Program.cs")
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-A", "toolCall": {"args": {"Path": target}}}
        )
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-B", "toolCall": {"args": {"Path": target}}}
        )
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-C", "toolCall": {"args": {"Path": target}}}
        )

        # Release conv-A -> conv-B (#1) gets 60s reservation
        _ = project_lock.handle_stop({"conversationId": "conv-A", "fullyIdle": True})
        locks = lock_store.list_active_locks()
        self.assertEqual(len(locks), 1)
        self.assertEqual(locks[0]["ownerId"], "conv-B")
        res_until = locks[0]["reservedUntil"]
        assert isinstance(res_until, float)
        self.assertGreater(res_until, time.time() + 40.0)

        # Third party conv-D cannot steal conv-B's reserved lock
        res_steal = _parse_json_dict(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-D", "toolCall": {"args": {"Path": target}}}
            )
        )
        self.assertEqual(res_steal["decision"], "deny")

        # Expire conv-B's reservation -> conv-D still cannot steal; #2 (conv-C) auto-promoted!
        with closing(sqlite3.connect(str(self.lock_dir / "locks.db"))) as conn:
            _ = conn.execute(
                "UPDATE locks SET reserved_until = ? WHERE module_key = ?",
                (time.time() - 1.0, "05.Tooling/02.UiAutomationMcp"),
            )
            conn.commit()

        res_after_exp = _parse_json_dict(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-D", "toolCall": {"args": {"Path": target}}}
            )
        )
        self.assertEqual(res_after_exp["decision"], "deny")
        locks_now = lock_store.list_active_locks()
        self.assertEqual(locks_now[0]["ownerId"], "conv-C")
        self.assertIsNotNone(locks_now[0]["reservedUntil"])
        self.assertTrue(
            any(e["event"] == "RESERVATION_EXPIRED" for e in lock_store.list_events(10))
        )

        # Promoted waiter conv-C claims reservation cleanly -> reservedUntil cleared
        res_claim = _parse_json_dict(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-C", "toolCall": {"args": {"Path": target}}}
            )
        )
        self.assertEqual(res_claim["decision"], "allow")
        claimed_locks = lock_store.list_active_locks()
        self.assertEqual(claimed_locks[0]["ownerId"], "conv-C")
        self.assertIsNone(claimed_locks[0]["reservedUntil"])

    def test_cli_auto_wakeup_agentapi_and_csrf_never_persisted(self) -> None:
        mock_exe, call_log = self._write_mock_agentapi(mode="ok")
        target = str(self.fake_new / "05.Tooling" / "01.CodeXray" / "lib.rs")
        csrf_secret = "super-secret-csrf-token-do-not-save"

        p1 = self._run_cli(
            ["pre-edit"],
            stdin_obj={
                "conversationId": "conv-A",
                "toolCall": {"args": {"Path": target}},
            },
            extra_env={
                "ANTIGRAVITY_PROJECT_ID": "proj-alpha",
                "ANTIGRAVITY_CSRF_TOKEN": csrf_secret,
                "ANTIGRAVITY_AGENT": "1",
            },
        )
        self.assertEqual(p1.returncode, 0)
        self.assertEqual(_parse_json_dict(p1.stdout)["decision"], "allow")

        p2 = self._run_cli(
            ["pre-edit"],
            stdin_obj={
                "conversationId": "conv-B",
                "toolCall": {"args": {"Path": target}},
            },
            extra_env={
                "ANTIGRAVITY_PROJECT_ID": "proj-beta",
                "ANTIGRAVITY_CSRF_TOKEN": csrf_secret,
                "ANTIGRAVITY_AGENT": "1",
            },
        )
        self.assertEqual(p2.returncode, 0)
        self.assertEqual(_parse_json_dict(p2.stdout)["decision"], "deny")

        # Stop hook triggers direct CLI agentapi wake with ANTIGRAVITY_PROJECT_ID=proj-beta
        p_stop = self._run_cli(
            ["stop"],
            stdin_obj={"conversationId": "conv-A", "fullyIdle": True},
            extra_env={
                "ANTIGRAVITY_AGENTAPI_EXE": str(mock_exe),
                "ANTIGRAVITY_PROJECT_ID": "proj-alpha",
                "ANTIGRAVITY_CSRF_TOKEN": csrf_secret,
            },
        )
        self.assertEqual(p_stop.returncode, 0)
        self.assertEqual(_parse_json_dict(p_stop.stdout)["decision"], "stop")
        self.assertTrue(call_log.is_file())
        calls = [
            json.loads(line)
            for line in call_log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["argv"][:3], ["agentapi", "send-message", "conv-B"])
        self.assertEqual(calls[0]["project_id"], "proj-beta")
        self.assertTrue(any(e["event"] == "WAKE_SENT" for e in lock_store.list_events(10)))

        # Verify CSRF token is NEVER persisted anywhere on disk
        db_bytes = (self.lock_dir / "locks.db").read_bytes()
        self.assertNotIn(csrf_secret.encode("utf-8"), db_bytes)
        hist = self.lock_dir / "history.log"
        if hist.exists():
            self.assertNotIn(csrf_secret, hist.read_text(encoding="utf-8"))

        # Test unlock CLI triggering WAKE_FAILED on non-zero exit & slow timeout
        fail_exe, _ = self._write_mock_agentapi(mode="fail")
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-C", "toolCall": {"args": {"Path": target}}}
        )
        p_un = self._run_cli(
            ["unlock", "--module", "05.Tooling/01.CodeXray"],
            extra_env={"ANTIGRAVITY_AGENTAPI_EXE": str(fail_exe)},
        )
        self.assertEqual(p_un.returncode, 0)
        self.assertIn("wake=failed", p_un.stdout)
        self.assertTrue(
            any(e["event"] == "WAKE_FAILED" for e in lock_store.list_events(10))
        )

        # Timeout test (slow script sleeps 5s > 3s timeout)
        slow_exe, _ = self._write_mock_agentapi(mode="slow")
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-D", "toolCall": {"args": {"Path": target}}}
        )
        p_slow = self._run_cli(
            ["unlock", "--module", "05.Tooling/01.CodeXray"],
            extra_env={"ANTIGRAVITY_AGENTAPI_EXE": str(slow_exe)},
        )
        self.assertEqual(p_slow.returncode, 0)
        self.assertIn("wake=failed", p_slow.stdout)
        self.assertTrue(
            any(
                e["event"] == "WAKE_FAILED" and e["detail"] == "timeout=3s"
                for e in lock_store.list_events(10)
            )
        )

        # Disabled auto_wake_enabled='0' suppresses wake invocation
        lock_store.set_setting("auto_wake_enabled", "0")
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-E", "toolCall": {"args": {"Path": target}}}
        )
        p_dis = self._run_cli(
            ["unlock", "--module", "05.Tooling/01.CodeXray"],
            extra_env={"ANTIGRAVITY_AGENTAPI_EXE": str(mock_exe)},
        )
        self.assertEqual(p_dis.returncode, 0)
        self.assertIn("wake=disabled", p_dis.stdout)

    def test_cli_queue_and_status_modes(self) -> None:
        target = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "Cli.cs")
        _ = project_lock.handle_pre_edit(
            {"conversationId": "conv-owner-1", "toolCall": {"args": {"Path": target}}}
        )
        _ = project_lock.handle_pre_edit(
            {
                "conversationId": "conv-ext-waiter",
                "sessionKind": "external",
                "toolCall": {"args": {"Path": target}},
            }
        )

        p_status = self._run_cli(["status"])
        self.assertEqual(p_status.returncode, 0)
        self.assertIn("05.Tooling/02.UiAutomationMcp", p_status.stdout)

        p_queue = self._run_cli(["queue"])
        self.assertEqual(p_queue.returncode, 0)
        self.assertIn("Wait queue: 1", p_queue.stdout)
        self.assertIn("agy --conversation conv-ext-waiter --continue", p_queue.stdout)

        p_qjson = self._run_cli(["queue", "--json"])
        self.assertEqual(p_qjson.returncode, 0)
        qdata = _parse_json_dict(p_qjson.stdout)
        self.assertEqual(qdata["autoWakeEnabled"], True)
        self.assertEqual(len(cast(list[object], qdata["locks"])), 1)
        self.assertEqual(len(cast(list[object], qdata["queue"])), 1)

    def test_multiprocess_sqlite_wal_concurrency(self) -> None:
        target = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "Race.cs")
        worker_count = 10
        env = os.environ.copy()
        env["PROJECT_LOCK_DIR"] = str(self.lock_dir)
        env["PROJECT_LOCK_CONFIG"] = str(self.config_path)
        env["PROJECT_LOCK_WORKSPACE_ROOT"] = str(self.fake_new)
        env["TEMP"] = str(self.fake_temp)
        env["TMP"] = str(self.fake_temp)

        procs: list[subprocess.Popen[str]] = []
        for idx in range(worker_count):
            payload = json.dumps(
                {
                    "conversationId": f"conv-race-{idx}",
                    "toolCall": {"args": {"Path": target}},
                }
            )
            proc = subprocess.Popen(
                [sys.executable, str(SCRIPTS_DIR / "project_lock.py"), "pre-edit"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                env=env,
            )
            procs.append(proc)
            assert proc.stdin is not None
            _ = proc.stdin.write(payload)
            proc.stdin.close()

        decisions: list[str] = []
        for proc in procs:
            assert proc.stdout is not None and proc.stderr is not None
            out = proc.stdout.read()
            err = proc.stderr.read()
            _ = proc.wait(timeout=15)
            self.assertEqual(proc.returncode, 0, f"Worker failed: {err}")
            decisions.append(str(_parse_json_dict(out)["decision"]))

        self.assertEqual(decisions.count("allow"), 1)
        self.assertEqual(decisions.count("deny"), worker_count - 1)
        self.assertEqual(len(lock_store.list_active_locks()), 1)
        self.assertEqual(len(lock_store.list_queue()), worker_count - 1)

    def test_wake_status_migration_and_deferred_hook_wake(self) -> None:
        # Simulate an older locks.db without lock_queue.wake_status
        legacy_db = self.lock_dir / "locks.db"
        with closing(sqlite3.connect(legacy_db)) as conn:
            _ = conn.execute(
                """
                CREATE TABLE lock_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_group_id TEXT NOT NULL,
                    module_key TEXT NOT NULL,
                    waiter_conv_id TEXT NOT NULL,
                    waiter_project_id TEXT NOT NULL DEFAULT '',
                    waiter_workspace TEXT NOT NULL DEFAULT '',
                    session_kind TEXT NOT NULL DEFAULT 'unknown',
                    reason_tag TEXT NOT NULL DEFAULT 'edit',
                    status TEXT NOT NULL DEFAULT 'waiting',
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    requested_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(module_key, waiter_conv_id)
                )
                """
            )
            conn.commit()

        _ = lock_store.init_db()
        with closing(sqlite3.connect(legacy_db)) as conn:
            cols = {
                str(r[1])
                for r in conn.execute("PRAGMA table_info(lock_queue)").fetchall()
            }
        self.assertIn("wake_status", cols)

        target = str(self.fake_new / "05.Tooling" / "01.CodeXray" / "Hook.cs")
        _ = project_lock.handle_pre_edit(
            {
                "conversationId": "conv-hook-owner",
                "toolCall": {"args": {"Path": target}},
            }
        )
        _ = project_lock.handle_pre_edit(
            {
                "conversationId": "conv-hook-waiter",
                "toolCall": {"args": {"Path": target}},
            }
        )

        # Simulate Antigravity Stop hook subprocess lacking agentapi / LS env vars
        clean_env = {
            "ANTIGRAVITY_AGENTAPI_EXE": "",
            "ANTIGRAVITY_LS_ADDRESS": "",
            "ANTIGRAVITY_CSRF_TOKEN": "",
        }
        p_stop = self._run_cli(
            ["stop"],
            stdin_obj={"conversationId": "conv-hook-owner", "fullyIdle": True},
            extra_env=clean_env,
        )
        self.assertEqual(p_stop.returncode, 0)
        events = lock_store.list_events(10)
        self.assertTrue(any(e["event"] == "WAKE_DEFERRED" for e in events))
        self.assertFalse(any(e["event"] == "WAKE_FAILED" for e in events))

        queue = lock_store.list_queue()
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["status"], "promoted")
        self.assertEqual(queue[0]["wakeStatus"], "pending")

        p_qjson = self._run_cli(["queue", "--json"])
        self.assertEqual(p_qjson.returncode, 0)
        qdata = _parse_json_dict(p_qjson.stdout)
        next_up = cast(list[dict[str, object]], qdata["nextUp"])
        self.assertEqual(len(next_up), 1)
        self.assertEqual(next_up[0]["waiterConvId"], "conv-hook-waiter")
        self.assertEqual(next_up[0]["wakeStatus"], "pending")

    def test_lookup_conversation_summaries_and_deny_title_link(self) -> None:
        summary_db = self.base / "conversation_summaries.db"
        with closing(sqlite3.connect(summary_db)) as conn:
            _ = conn.execute(
                """
                CREATE TABLE conversation_summaries (
                    conversation_id TEXT PRIMARY KEY,
                    title TEXT,
                    workspace_uris TEXT
                )
                """
            )
            _ = conn.execute(
                "INSERT INTO conversation_summaries VALUES (?, ?, ?)",
                (
                    "conv-sum-owner",
                    "WPF MVVM Refactoring",
                    '["file:///D:/Workspace/00.SharedCore"]',
                ),
            )
            _ = conn.execute(
                "INSERT INTO conversation_summaries VALUES (?, ?, ?)",
                (
                    "conv-sum-waiter",
                    "Unit Test Suite",
                    "file:///D:/Workspace/02.Libraries",
                ),
            )
            conn.commit()

        missing_db = self.base / "missing.db"
        resolved = lock_store.lookup_conversation_summaries(
            ["conv-sum-owner", "conv-sum-waiter", "unknown", "conv-sum-owner"],
            db_paths=[missing_db, summary_db],
        )
        self.assertEqual(resolved["conv-sum-owner"]["title"], "WPF MVVM Refactoring")
        self.assertEqual(resolved["conv-sum-owner"]["workspaceName"], "00.SharedCore")
        self.assertEqual(resolved["conv-sum-waiter"]["title"], "Unit Test Suite")
        self.assertEqual(resolved["conv-sum-waiter"]["workspaceName"], "02.Libraries")

        target = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "View.cs")
        with mock.patch.object(
            lock_store, "default_summary_db_paths", return_value=(summary_db,)
        ):
            allow_out = project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-sum-owner",
                    "toolCall": {"args": {"Path": target}},
                }
            )
            self.assertEqual(_parse_json_dict(allow_out)["decision"], "allow")

            deny_out = project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-sum-waiter",
                    "toolCall": {"args": {"Path": target}},
                }
            )
            deny_obj = _parse_json_dict(deny_out)
            self.assertEqual(deny_obj["decision"], "deny")
            reason = str(deny_obj["reason"])
            self.assertIn("WPF MVVM Refactoring", reason)
            self.assertIn("sidecar://project-lock/lock_board/", reason)

            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = project_lock.cmd_queue(as_json=True)
                self.assertEqual(rc, 0)
            qjson = _parse_json_dict(buf.getvalue())

        locks = cast(list[dict[str, object]], qjson["locks"])
        queue = cast(list[dict[str, object]], qjson["queue"])
        next_up = cast(list[dict[str, object]], qjson["nextUp"])
        self.assertEqual(locks[0]["ownerTitle"], "WPF MVVM Refactoring")
        nw = cast(dict[str, object], locks[0]["nextWaiter"])
        self.assertEqual(nw["waiterTitle"], "Unit Test Suite")
        self.assertEqual(queue[0]["waiterTitle"], "Unit Test Suite")
        self.assertEqual(queue[0]["isNextUp"], True)
        self.assertEqual(len(next_up), 1)

    def test_session_start_hook_emits_user_markdown_sidecar_link(self) -> None:
        for stdin_obj in ({"conversationId": "conv-start"}, None):
            proc = self._run_cli(["session-start"], stdin_obj=stdin_obj)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = _parse_json_dict(proc.stdout)
            steps = cast(list[dict[str, object]], out["injectSteps"])
            self.assertEqual(len(steps), 1)
            sys_msg = cast(dict[str, object], steps[0]["systemMessage"])
            self.assertEqual(sys_msg["systemMessage"], "")
            meta = cast(dict[str, object], sys_msg["metadata"])
            self.assertIn(
                "sidecar://project-lock/lock_board/",
                str(meta["user_markdown"]),
            )

    def test_session_lock_limit_cap_and_reacquire_and_cli_quota(self) -> None:
        guard = lock_store.get_guard_settings()
        self.assertEqual(guard.max_locks_per_session, 4)
        self.assertEqual(guard.max_shared_deps_without_nodeps, 3)

        # Inline env vars must NOT override lock_settings guard thresholds
        with mock.patch.dict(
            os.environ,
            {
                "PROJECT_LOCK_MAX_LOCKS": "99",
                "MAX_LOCKS_PER_SESSION": "99",
            },
        ):
            guard_env = lock_store.get_guard_settings()
            self.assertEqual(guard_env.max_locks_per_session, 4)

        paths = [
            str(self.fake_new / "00.SharedCore" / "src" / "Shared.UI" / "A.cs"),
            str(self.fake_new / "00.SharedCore" / "src" / "Shared.Core" / "B.cs"),
            str(self.fake_new / "02.Libraries" / "SupportKit" / "C.cs"),
            str(self.fake_new / "05.Tooling" / "01.CodeXray" / "D.rs"),
        ]
        fifth_path = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "E.cs")

        for idx, fpath in enumerate(paths):
            res = _parse_json_dict(
                project_lock.handle_pre_edit(
                    {
                        "conversationId": "conv-cap",
                        "toolCall": {"args": {"Path": fpath}},
                    }
                )
            )
            self.assertEqual(res["decision"], "allow", f"Failed on lock #{idx + 1}")

        self.assertEqual(len(lock_store.list_active_locks()), 4)

        # Re-editing already-held 4th lock stays allowed at 4/4
        res_reacquire = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-cap",
                    "toolCall": {"args": {"Path": paths[3]}},
                }
            )
        )
        self.assertEqual(res_reacquire["decision"], "allow")

        # Attempting a 5th new module is denied immediately without queueing
        res_fifth = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-cap",
                    "toolCall": {"args": {"Path": fifth_path}},
                }
            )
        )
        self.assertEqual(res_fifth["decision"], "deny")
        reason = str(res_fifth["reason"])
        self.assertIn("LIMIT_DENIED", reason)
        self.assertIn("4/4", reason)
        self.assertIn("sidecar://project-lock/lock_board/", reason)
        self.assertEqual(lock_store.list_queue(), [])
        events = lock_store.list_events(10)
        self.assertTrue(any(e["event"] == "LIMIT_DENIED" for e in events))

        # acquire_atomic_group(..., max_locks=...) override & status/queue enrichment
        mod_fifth = lock_store.resolve_module_target(fifth_path)
        assert mod_fifth is not None
        res_custom = lock_store.acquire_atomic_group(
            [(mod_fifth, "edit")], "conv-cap", max_locks=2
        )
        self.assertFalse(res_custom.acquired)
        self.assertEqual(res_custom.status, "LIMIT_EXCEEDED")
        self.assertEqual(res_custom.limit, 2)
        self.assertEqual(len(res_custom.held_modules), 4)

        p_status = self._run_cli(["status", "--json"])
        self.assertEqual(p_status.returncode, 0, p_status.stderr)
        sjson = _parse_json_dict(p_status.stdout)
        self.assertEqual(sjson["maxLocksPerSession"], 4)
        slocks = cast(list[dict[str, object]], sjson["locks"])
        self.assertEqual(len(slocks), 4)
        self.assertTrue(all(lk["ownerLockCount"] == 4 for lk in slocks))
        self.assertTrue(all(lk["maxLocksPerSession"] == 4 for lk in slocks))

        p_status_txt = self._run_cli(["status"])
        self.assertEqual(p_status_txt.returncode, 0)
        self.assertIn("ownerLocks=4/4", p_status_txt.stdout)

        p_queue = self._run_cli(["queue", "--json"])
        self.assertEqual(p_queue.returncode, 0, p_queue.stderr)
        qjson = _parse_json_dict(p_queue.stdout)
        self.assertEqual(qjson["maxLocksPerSession"], 4)
        qlocks = cast(list[dict[str, object]], qjson["locks"])
        self.assertEqual(qlocks[0]["ownerLockCount"], 4)

    def test_dep_cascade_guard_three_or_more_vs_two_and_no_deps(self) -> None:
        cm_slnx, _, ui_csproj, gen_csproj = self._make_dotnet_fixture()
        cm_cwd = str(cm_slnx.parent)

        # >= 3 external shared deps without --no-dependencies -> DEP_GUARD_DENIED
        res_three = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-dep-3",
                    "cwd": cm_cwd,
                    "toolCall": {"args": {"CommandLine": "dotnet build DesktopClient.slnx"}},
                }
            )
        )
        self.assertEqual(res_three["decision"], "deny")
        reason = str(res_three["reason"])
        self.assertIn("DEP_GUARD_DENIED", reason)
        self.assertIn("--no-dependencies", reason)
        self.assertIn("sidecar://project-lock/lock_board/", reason)
        self.assertEqual(lock_store.list_active_locks(), [])
        self.assertEqual(lock_store.list_queue(), [])
        self.assertTrue(
            any(e["event"] == "DEP_GUARD_DENIED" for e in lock_store.list_events(10))
        )

        # With --no-dependencies -> allowed (only own module locked)
        res_nodeps = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-dep-nodeps",
                    "cwd": cm_cwd,
                    "toolCall": {
                        "args": {"CommandLine": "dotnet build DesktopClient.slnx --no-dependencies"}
                    },
                }
            )
        )
        self.assertEqual(res_nodeps["decision"], "allow")
        self.assertEqual(
            [str(lk["moduleKey"]) for lk in lock_store.list_active_locks()],
            ["01.Apps/DesktopClient"],
        )

        # <= 2 external shared deps without --no-dependencies -> allowed
        _ = lock_store.unlock_locks(unlock_all=True)
        two_dep_dir = self.fake_new / "01.Apps" / "TinyApp"
        two_dep_dir.mkdir(parents=True, exist_ok=True)
        tiny_csproj = two_dep_dir / "TinyApp.csproj"
        _ = tiny_csproj.write_text(
            '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>'
            f'<ProjectReference Include="{ui_csproj}" />'
            f'<ProjectReference Include="{gen_csproj}" />'
            "</ItemGroup></Project>\n",
            encoding="utf-8",
        )
        res_two = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-dep-2",
                    "cwd": str(two_dep_dir),
                    "toolCall": {"args": {"CommandLine": "dotnet build TinyApp.csproj"}},
                }
            )
        )
        self.assertEqual(res_two["decision"], "allow")
        self.assertEqual(
            {str(lk["moduleKey"]) for lk in lock_store.list_active_locks()},
            {
                "01.Apps/TinyApp",
                "00.SharedCore/Shared.UI",
                "00.SharedCore/Shared.Generators",
            },
        )

    def test_powershell_loop_try_git_and_docker_read_only_vs_mutating(self) -> None:
        cm_slnx, common_slnx, _, _ = self._make_dotnet_fixture()
        common_dir = str(common_slnx.parent)
        cm_dir = str(cm_slnx.parent)

        ro_scripts = [
            (
                f"$repos = @('{common_dir}', '{cm_dir}')\n"
                "foreach ($r in $repos) {\n"
                "  Write-Host \"=== $r ===\"\n"
                "  git -C $r status --short\n"
                "  git -C $r ls-remote origin\n"
                "  git -C $r rev-list --count HEAD\n"
                "}"
            ),
            (
                f"foreach ($r in @('{common_dir}', '{cm_dir}')) "
                "{ git -C $r status 2>$null }"
            ),
            f"@('{common_dir}', '{cm_dir}') | foreach {{ git -C $_ status }}",
            (
                f"Push-Location '{common_dir}'; "
                "try { git cat-file -t HEAD; git diff-tree -r HEAD; "
                "git describe --tags; git show-ref; git for-each-ref; "
                "git check-ignore a; git count-objects; git var GIT_AUTHOR_IDENT } "
                "finally { Pop-Location }"
            ),
            (
                f"if (Test-Path '{cm_dir}') {{ "
                "Get-Content a.json | ConvertFrom-Json | Out-String } "
                "else { Split-Path 'a/b' -Parent | Format-Custom }"
            ),
            "docker --version && docker ps -a && docker volume ls && docker network inspect bridge",
            "docker compose -f compose.yml -p app config",
            "docker compose logs --tail 20 app",
            "Join-Path 'a' 'b' | Write-Output",
            'Select-String -Pattern "a>b" foo.txt',
            "git status 2>&1",
        ]
        for script in ro_scripts:
            self.assertTrue(
                build_inspector.is_read_only_command(script),
                f"Expected read-only for:\n{script}",
            )
            res = _parse_json_dict(
                project_lock.handle_pre_command(
                    {
                        "conversationId": "conv-ps-ro",
                        "cwd": cm_dir,
                        "toolCall": {"args": {"CommandLine": script}},
                    }
                )
            )
            self.assertEqual(res["decision"], "allow")
            self.assertEqual(
                lock_store.list_active_locks(),
                [],
                f"Expected 0 locks for:\n{script}",
            )

        # Depth limit (> 4) and unknown/mutating commands must fail closed
        deep_five = (
            "foreach ($a in @('x')) { foreach ($b in @('x')) { "
            "foreach ($c in @('x')) { foreach ($d in @('x')) { "
            "foreach ($e in @('x')) { git status } } } } }"
        )
        self.assertFalse(build_inspector.is_read_only_command(deep_five))

        mutating_or_unknown = [
            f"foreach ($r in @('{common_dir}', '{cm_dir}')) {{ git -C $r push }}",
            f"foreach ($r in @('{common_dir}', '{cm_dir}')) {{ Set-Content \"$r\\x.txt\" 'hi' }}",
            "try { git status } finally { unknown-custom-tool }",
            'Write-Host "$(python evil.py)"',
            "Add-Type -TypeDefinition 'public class X {}'",
            "Get-Process | Export-Csv out.csv",
            "Invoke-WebRequest https://example.com -OutFile a.zip",
            "docker build .",
            "docker compose up -d",
            "docker compose build",
            "docker run --rm alpine ls",
            "docker exec -it web sh",
            "docker volume rm myvol",
            "git status & npm install",
            "git status & docker compose down",
            'foreach ($x in @("a")) { git status & npm install }',
            "git status 2>out.txt",
            "git status --porcelain>out.txt",
            "echo hi *>out.txt",
            "echo hi 2>>out.txt",
        ]
        for bad_cmd in mutating_or_unknown:
            self.assertFalse(
                build_inspector.is_read_only_command(bad_cmd),
                f"Expected False for: {bad_cmd}",
            )

        # Mutating foreach { git push } and { Set-Content } acquire module locks
        res_push = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-mut-push",
                    "cwd": cm_dir,
                    "toolCall": {"args": {"CommandLine": mutating_or_unknown[0]}},
                }
            )
        )
        self.assertEqual(res_push["decision"], "allow")
        self.assertEqual(
            {str(lk["moduleKey"]) for lk in lock_store.list_active_locks()},
            {"00.SharedCore/_root", "01.Apps/DesktopClient"},
        )

        _ = lock_store.unlock_locks(unlock_all=True)
        res_set = _parse_json_dict(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-mut-set",
                    "cwd": cm_dir,
                    "toolCall": {"args": {"CommandLine": mutating_or_unknown[1]}},
                }
            )
        )
        self.assertEqual(res_set["decision"], "allow")
        self.assertEqual(
            {str(lk["moduleKey"]) for lk in lock_store.list_active_locks()},
            {"00.SharedCore/_root", "01.Apps/DesktopClient"},
        )

    def test_transcript_child_lineage_rejects_noise_and_matches_spawns(self) -> None:
        tp_a = self.base / "session_a_transcript.jsonl"
        fake_spawn_json = json.dumps({"status": "added", "conversation_id": "conv-B"})
        lines = [
            json.dumps(
                {
                    "type": "USER_INPUT",
                    "source": "USER_EXPLICIT",
                    "content": (
                        f"Check conv-B and {fake_spawn_json}\n"
                        'Created the following subagent:\n{"conversationId":"conv-B"}'
                    ),
                }
            ),
            json.dumps(
                {
                    "type": "CHECKPOINT",
                    "source": "MODEL",
                    "content": "checkpoint referencing conv-B",
                }
            ),
            json.dumps(
                {
                    "type": "PLANNER_RESPONSE",
                    "source": "MODEL",
                    "thinking": "Session conv-B holds locks in locks.db",
                    "tool_calls": [
                        {"name": "run_command", "args": {"CommandLine": "status"}}
                    ],
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": (
                        "Created At: 2026-11-19T15:00:00+09:00\n"
                        "Completed At: 2026-11-19T15:00:01+09:00\n"
                        "Command exited with code 0.\n\n"
                        "Command output:\n"
                        f"owner=conv-B | {fake_spawn_json}\n"
                        'Created the following subagent:\n{"conversationId":"conv-B"}'
                    ),
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": "Showing lines 1-5 of 5\n1: conv-B",
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": json.dumps({"messages": [{"seq": 1, "text": "conv-B"}]}),
                }
            ),
            "not-valid-json conv-B",
            json.dumps(
                {
                    "type": "PLANNER_RESPONSE",
                    "source": "MODEL",
                    "tool_calls": [
                        {"name": "invoke_subagent", "args": {"Prompt": "inspect"}}
                    ],
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": (
                        "Created At: 2026-11-19T15:01:00+09:00\n"
                        "Completed At: 2026-11-19T15:01:01+09:00\n"
                        "Created the following subagent:\n"
                        '{\n  "conversationId": "subagent-real-1"\n}\n'
                        "The subagent will send you a message when done."
                    ),
                }
            ),
            json.dumps(
                {
                    "type": "PLANNER_RESPONSE",
                    "source": "MODEL",
                    "tool_calls": [
                        {"name": "swarm", "args": {"action": '"title"'}},
                        {"name": "swarm", "args": {"action": '"add"', "name": '"w1"'}},
                        {"name": "swarm", "args": {"action": '"add"', "name": '"w2"'}},
                        {"name": "run_command", "args": {"CommandLine": "echo hi"}},
                    ],
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": (
                        "Created At: 2026-11-19T15:02:00+09:00\n"
                        "Completed At: 2026-11-19T15:02:01+09:00\n"
                        '{"status":"titled","title":"work"}'
                    ),
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": (
                        "Command exited with code 0.\n\n"
                        f"Command output:\n{fake_spawn_json}"
                    ),
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": (
                        "Created At: 2026-11-19T15:02:02+09:00\n"
                        "Completed At: 2026-11-19T15:02:03+09:00\n"
                        "Created At: 2026-11-19T15:02:02+09:00\n"
                        "Completed At: 2026-11-19T15:02:03+09:00\n"
                        '{"status":"added","name":"w1","conversation_id":"swarm-child-1"}'
                    ),
                }
            ),
            json.dumps(
                {
                    "type": "GENERIC",
                    "source": "MODEL",
                    "content": (
                        "Created At: 2026-11-19T15:02:04+09:00\n"
                        "Completed At: 2026-11-19T15:02:05+09:00\n"
                        '{"status":"added","name":"w2","conversation_id":"swarm-child-2"}'
                    ),
                }
            ),
            json.dumps({"type": "tool_call", "child": "legacy-child-1"}),
        ]
        _ = tp_a.write_text("\n".join(lines) + "\n", encoding="utf-8")

        self.assertFalse(lock_store._is_child_of_owner("conv-B", str(tp_a)))
        self.assertFalse(lock_store._is_child_of_owner("", str(tp_a)))
        self.assertFalse(lock_store._is_child_of_owner("unknown", str(tp_a)))
        self.assertTrue(lock_store._is_child_of_owner("subagent-real-1", str(tp_a)))
        self.assertTrue(lock_store._is_child_of_owner("swarm-child-1", str(tp_a)))
        self.assertTrue(lock_store._is_child_of_owner("swarm-child-2", str(tp_a)))
        self.assertTrue(lock_store._is_child_of_owner("legacy-child-1", str(tp_a)))

        # Session A acquires 4 locks (at 4/4 cap); unrelated conv-B must NOT inherit them
        a_paths = [
            str(self.fake_new / "00.SharedCore" / "src" / "Shared.UI" / "A.cs"),
            str(self.fake_new / "00.SharedCore" / "src" / "Shared.Core" / "B.cs"),
            str(self.fake_new / "02.Libraries" / "SupportKit" / "C.cs"),
            str(self.fake_new / "05.Tooling" / "01.CodeXray" / "D.rs"),
        ]
        for fpath in a_paths:
            res = _parse_json_dict(
                project_lock.handle_pre_edit(
                    {
                        "conversationId": "conv-A",
                        "transcriptPath": str(tp_a),
                        "toolCall": {"args": {"Path": fpath}},
                    }
                )
            )
            self.assertEqual(res["decision"], "allow")

        b_path = str(self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "E.cs")
        res_b = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-B",
                    "toolCall": {"args": {"Path": b_path}},
                }
            )
        )
        self.assertEqual(res_b["decision"], "allow")

        # Genuine child inherits conv-A's owner tree (re-edit allowed, new 6th module denied)
        res_child_held = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "swarm-child-1",
                    "toolCall": {"args": {"Path": a_paths[0]}},
                }
            )
        )
        self.assertEqual(res_child_held["decision"], "allow")

        sixth_path = str(self.fake_new / "01.Apps" / "DesktopClient" / "F.cs")
        res_child_cap = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "swarm-child-1",
                    "toolCall": {"args": {"Path": sixth_path}},
                }
            )
        )
        self.assertEqual(res_child_cap["decision"], "deny")
        self.assertIn("LIMIT_DENIED", str(res_child_cap["reason"]))

    def test_standalone_repo_resolution_without_config_json(self) -> None:
        empty_lock_dir = (self.base / "empty_locks").resolve()
        empty_lock_dir.mkdir(parents=True, exist_ok=True)
        standalone_repo = (self.base / "standalone_rust_app").resolve()
        (standalone_repo / "src").mkdir(parents=True, exist_ok=True)
        _ = (standalone_repo / "Cargo.toml").write_text(
            '[package]\nname = "standalone"\nversion = "0.1.0"\n',
            encoding="utf-8",
        )
        src_file = standalone_repo / "src" / "main.rs"
        _ = src_file.write_text("fn main() {}\n", encoding="utf-8")

        with (
            mock.patch.dict(
                os.environ,
                {
                    "PROJECT_LOCK_DIR": str(empty_lock_dir),
                    "PROJECT_LOCK_CONFIG": str(empty_lock_dir / "missing.json"),
                    "PROJECT_LOCK_WORKSPACE_ROOT": "",
                },
            ),
            mock.patch.object(lock_store, "LOCK_ROOT", empty_lock_dir),
            mock.patch.object(lock_store, "NEW_ROOT", None),
        ):
            mod = lock_store.resolve_module_target(src_file)
            assert mod is not None
            self.assertTrue(mod.key.startswith("ext/standalone_rust_app_"))
            self.assertEqual(mod.root, standalone_repo)
            self.assertFalse(mod.is_shared)

    def test_swarm_claim_release_cli_survives_coordinator_stop_and_promotes(
        self,
    ) -> None:
        # 1. Coordinator claims 2 modules on behalf of swarm-worker-1
        p_claim = self._run_cli(
            [
                "claim",
                "--conv-id",
                "swarm-worker-1",
                "--modules",
                "05.Tooling/01.CodeXray,02.Libraries/SupportKit",
                "--workspace",
                str(self.fake_new / "05.Tooling" / "01.CodeXray"),
                "--json",
            ]
        )
        self.assertEqual(p_claim.returncode, 0, p_claim.stdout + p_claim.stderr)
        claim_data = _parse_json_dict(p_claim.stdout)
        self.assertTrue(claim_data["acquired"])

        # 2. Coordinator ends its turn (`stop`): worker-owned locks stay intact
        _ = project_lock.handle_stop(
            {"conversationId": "coord-parent", "fullyIdle": True}
        )
        active = {str(x["moduleKey"]): str(x["ownerId"]) for x in lock_store.list_active_locks()}
        self.assertEqual(active.get("05.Tooling/01.CodeXray"), "swarm-worker-1")
        self.assertEqual(active.get("02.Libraries/SupportKit"), "swarm-worker-1")

        # 3. External session is blocked & queued on 05.Tooling/01.CodeXray
        ext_res = _parse_json_dict(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-external-waiter",
                    "toolCall": {
                        "args": {
                            "Path": str(
                                self.fake_new / "05.Tooling" / "01.CodeXray" / "lib.rs"
                            )
                        }
                    },
                }
            )
        )
        self.assertEqual(ext_res["decision"], "deny")

        # 4. Second claim by another worker on same module fails cleanly (rc=2)
        p_conflict = self._run_cli(
            [
                "claim",
                "--conv-id",
                "swarm-worker-2",
                "--modules",
                "05.Tooling/01.CodeXray",
                "--json",
            ]
        )
        self.assertEqual(p_conflict.returncode, 2)
        self.assertFalse(_parse_json_dict(p_conflict.stdout)["acquired"])

        # 5. Releasing swarm-worker-1 promotes conv-external-waiter automatically
        p_rel = self._run_cli(["release", "--conv-id", "swarm-worker-1", "--json"])
        self.assertEqual(p_rel.returncode, 0, p_rel.stdout + p_rel.stderr)
        rel_data = _parse_json_dict(p_rel.stdout)
        self.assertEqual(
            set(cast(list[str], rel_data["released"])),
            {"05.Tooling/01.CodeXray", "02.Libraries/SupportKit"},
        )
        self.assertEqual(rel_data["promotedCount"], 1)
        new_active = {
            str(x["moduleKey"]): str(x["ownerId"]) for x in lock_store.list_active_locks()
        }
        self.assertEqual(new_active.get("05.Tooling/01.CodeXray"), "conv-external-waiter")


if __name__ == "__main__":
    _ = unittest.main(verbosity=2)
