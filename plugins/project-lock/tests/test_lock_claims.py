#!/usr/bin/env python3
"""Unit tests for Phase 1 4-tier granular claims, worktree scopes, and PostToolUse release."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from typing import cast
from unittest import mock

_HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = _HERE.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import claim_store
import lock_store
import project_lock


def _parse_json(raw: str) -> dict[str, object]:
    loaded: object = json.loads(raw)
    assert isinstance(loaded, dict)
    return cast(dict[str, object], loaded)


class GranularClaimTests(unittest.TestCase):
    base: Path
    lock_dir: Path
    fake_new: Path
    fake_brain: Path
    config_path: Path
    _tmp: tempfile.TemporaryDirectory[str]
    _stack: ExitStack

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name).resolve()
        self.lock_dir = (self.base / "locks").resolve()
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        self.fake_new = (self.base / "workspace").resolve()
        self.fake_new.mkdir(parents=True, exist_ok=True)
        self.fake_brain = (self.base / "brain").resolve()
        self.fake_brain.mkdir(parents=True, exist_ok=True)
        self.config_path = self.lock_dir / "config.json"
        _ = self.config_path.write_text(
            json.dumps(
                {
                    "workspaceRoot": str(self.fake_new),
                    "sharedSrcGroups": ["00.sharedcore"],
                    "sharedGroups": ["02.libraries"],
                    "appGroups": ["01.apps", "05.tooling"],
                }
            ),
            encoding="utf-8",
        )
        self._stack = ExitStack()
        self._stack.enter_context(
            mock.patch.dict(
                os.environ,
                {
                    "PROJECT_LOCK_DIR": str(self.lock_dir),
                    "PROJECT_LOCK_CONFIG": str(self.config_path),
                    "PROJECT_LOCK_WORKSPACE_ROOT": str(self.fake_new),
                    "ANTIGRAVITY_AGENTAPI_EXE": "",
                    "ANTIGRAVITY_LS_ADDRESS": "",
                    "ANTIGRAVITY_CSRF_TOKEN": "",
                    "ANTIGRAVITY_CONVERSATION_ID": "",
                    "ANTIGRAVITY_PARENT_CONVERSATION_ID": "",
                },
            )
        )
        self._stack.enter_context(mock.patch.object(lock_store, "LOCK_ROOT", self.lock_dir))
        self._stack.enter_context(mock.patch.object(lock_store, "LOCK_DB", self.lock_dir / "locks.db"))
        self._stack.enter_context(mock.patch.object(lock_store, "HISTORY_LOG", self.lock_dir / "history.log"))
        self._stack.enter_context(mock.patch.object(lock_store, "NEW_ROOT", self.fake_new))
        self._stack.enter_context(
            mock.patch.object(lock_store, "_default_brain_roots", return_value=(self.fake_brain,))
        )
        self._stack.enter_context(mock.patch.object(project_lock, "is_file_os_locked", return_value=False))

    def tearDown(self) -> None:
        self._stack.close()
        self._tmp.cleanup()

    def _run_cli(
        self,
        args: list[str],
        *,
        stdin_obj: dict[str, object] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PROJECT_LOCK_DIR"] = str(self.lock_dir)
        env["PROJECT_LOCK_CONFIG"] = str(self.config_path)
        env["PROJECT_LOCK_WORKSPACE_ROOT"] = str(self.fake_new)
        env["USERPROFILE"] = str(self.base)
        env["HOME"] = str(self.base)
        env["ANTIGRAVITY_CONVERSATION_ID"] = ""
        env["ANTIGRAVITY_PARENT_CONVERSATION_ID"] = ""
        return subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "project_lock.py"), *args],
            input=json.dumps(stdin_obj) if stdin_obj is not None else "",
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )

    def test_disjoint_file_write_parallelism_and_same_file_block(self) -> None:
        mod_dir = self.fake_new / "05.Tooling" / "02.UiAutomationMcp" / "src"
        mod_dir.mkdir(parents=True, exist_ok=True)
        file_a = mod_dir / "ViewA.cs"
        file_b = mod_dir / "ViewB.cs"

        res_a = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-a", "toolCall": {"args": {"Path": str(file_a)}}}
            )
        )
        res_b = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-b", "toolCall": {"args": {"Path": str(file_b)}}}
            )
        )
        self.assertEqual(res_a["decision"], "allow")
        self.assertEqual(res_b["decision"], "allow")

        res_c = _parse_json(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-c",
                    "cwd": str(mod_dir.parent),
                    "toolCall": {"args": {"Path": "src\\viewa.cs"}},
                }
            )
        )
        self.assertEqual(res_c["decision"], "deny")
        self.assertIn("FILE_WRITE: src/viewa.cs", str(res_c["reason"]))

        claims = lock_store.list_active_claims()
        owners = {(str(c["ownerId"]), str(c["fileRelpath"])) for c in claims}
        self.assertEqual(owners, {("conv-a", "src/viewa.cs"), ("conv-b", "src/viewb.cs")})

    def test_test_shared_parallel_with_file_write_and_post_command_release(self) -> None:
        kit_dir = self.fake_new / "02.Libraries" / "SupportKit"
        kit_dir.mkdir(parents=True, exist_ok=True)
        csproj = kit_dir / "SupportKit.csproj"
        _ = csproj.write_text('<Project Sdk="Microsoft.NET.Sdk" />\n', encoding="utf-8")

        res_edit = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-edit", "toolCall": {"args": {"Path": str(kit_dir / "Helper.cs")}}}
            )
        )
        self.assertEqual(res_edit["decision"], "allow")

        res_test1 = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-test-1",
                    "cwd": str(kit_dir),
                    "toolCall": {"id": "tc-test-1", "args": {"CommandLine": "dotnet test SupportKit.csproj --no-build"}},
                }
            )
        )
        res_test2 = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-test-2",
                    "cwd": str(kit_dir),
                    "toolCall": {"id": "tc-test-2", "args": {"CommandLine": "python -m unittest"}},
                }
            )
        )
        self.assertEqual(res_test1["decision"], "allow")
        self.assertEqual(res_test2["decision"], "allow")

        res_build = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-build",
                    "cwd": str(kit_dir),
                    "toolCall": {"id": "tc-build-1", "args": {"CommandLine": "dotnet build SupportKit.csproj --no-restore"}},
                }
            )
        )
        self.assertEqual(res_build["decision"], "deny")

        _ = project_lock.handle_post_command(
            {"conversationId": "conv-test-1", "toolCall": {"id": "tc-test-1"}}
        )
        _ = project_lock.handle_post_command(
            {"conversationId": "conv-test-2", "toolCall": {"id": "tc-test-2"}}
        )

        remaining = lock_store.list_active_claims()
        self.assertEqual([(str(c["ownerId"]), str(c["lockMode"])) for c in remaining], [("conv-edit", "FILE_WRITE")])

    def test_build_excl_post_command_immediate_release_and_promotion(self) -> None:
        kit_dir = self.fake_new / "02.Libraries" / "SupportKit"
        kit_dir.mkdir(parents=True, exist_ok=True)
        _ = (kit_dir / "SupportKit.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk" />\n', encoding="utf-8")

        res_build = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-builder",
                    "cwd": str(kit_dir),
                    "toolCall": {
                        "id": "tc-bld-99",
                        "args": {"CommandLine": "dotnet build SupportKit.csproj --no-dependencies"},
                    },
                }
            )
        )
        self.assertEqual(res_build["decision"], "allow")

        res_waiter = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-waiter", "toolCall": {"args": {"Path": str(kit_dir / "Next.cs")}}}
            )
        )
        self.assertEqual(res_waiter["decision"], "deny")

        proc_post = self._run_cli(
            ["post-command"],
            stdin_obj={"conversationId": "conv-builder", "toolCall": {"id": "tc-bld-99", "name": "run_command"}},
        )
        self.assertEqual(proc_post.returncode, 0, proc_post.stderr)
        self.assertEqual(_parse_json(proc_post.stdout), {})

        claims = lock_store.list_active_claims()
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["ownerId"], "conv-waiter")
        self.assertEqual(claims[0]["lockMode"], "FILE_WRITE")
        self.assertEqual(claims[0]["fileRelpath"], "next.cs")
        self.assertIsNotNone(claims[0]["reservedUntil"])

    def test_worktree_physical_scope_isolation(self) -> None:
        wt1 = (self.base / "wt_alpha").resolve()
        wt2 = (self.base / "wt_beta").resolve()
        for wt in (wt1, wt2):
            (wt / ".git").mkdir(parents=True, exist_ok=True)
            _ = (wt / "main.py").write_text("print(1)\n", encoding="utf-8")

        cfg_path = self.lock_dir / "empty_cfg.json"
        _ = cfg_path.write_text('{"workspaceRoot": ""}', encoding="utf-8")
        with mock.patch.dict(
            os.environ,
            {"PROJECT_LOCK_CONFIG": str(cfg_path), "PROJECT_LOCK_WORKSPACE_ROOT": ""},
        ), mock.patch.object(lock_store, "NEW_ROOT", None):
            r1 = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": "conv-wt1", "toolCall": {"args": {"Path": str(wt1 / "main.py")}}}
                )
            )
            r2 = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": "conv-wt2", "toolCall": {"args": {"Path": str(wt2 / "main.py")}}}
                )
            )
            r3 = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": "conv-wt1-dup", "toolCall": {"args": {"Path": str(wt1 / "main.py")}}}
                )
            )
            self.assertEqual(r1["decision"], "allow")
            self.assertEqual(r2["decision"], "allow")
            self.assertEqual(r3["decision"], "deny")

    def test_session_module_cap_counts_distinct_modules_across_many_files(self) -> None:
        m1 = self.fake_new / "00.SharedCore" / "src" / "Shared.UI"
        m2 = self.fake_new / "00.SharedCore" / "src" / "Shared.Core"
        m3 = self.fake_new / "02.Libraries" / "SupportKit"
        m4 = self.fake_new / "05.Tooling" / "01.CodeXray"
        m5 = self.fake_new / "01.Apps" / "DesktopClient"
        m6 = self.fake_new / "05.Tooling" / "02.UiAutomationMcp"
        m7 = self.fake_new / "02.Libraries" / "MathKit"
        m8 = self.fake_new / "01.Apps" / "ServerPortal"
        m9 = self.fake_new / "00.SharedCore" / "src" / "Shared.Net"

        for idx in range(5):
            r = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": "conv-cap", "toolCall": {"args": {"Path": str(m1 / f"F{idx}.cs")}}}
                )
            )
            self.assertEqual(r["decision"], "allow")

        for mod_dir, fname in (
            (m2, "B.cs"),
            (m3, "C.cs"),
            (m4, "D.rs"),
            (m5, "E.cs"),
            (m6, "F.cs"),
            (m7, "G.cs"),
            (m8, "H.cs"),
        ):
            r = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": "conv-cap", "toolCall": {"args": {"Path": str(mod_dir / fname)}}}
                )
            )
            self.assertEqual(r["decision"], "allow")

        r8_same = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-cap", "toolCall": {"args": {"Path": str(m8 / "H2.cs")}}}
            )
        )
        self.assertEqual(r8_same["decision"], "allow")

        r9 = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-cap", "toolCall": {"args": {"Path": str(m9 / "Program.cs")}}}
            )
        )
        self.assertEqual(r9["decision"], "deny")
        self.assertIn("LIMIT_DENIED", str(r9["reason"]))
        self.assertIn("8/8", str(r9["reason"]))

    def test_lint_none_vs_fix_and_claim_mode_and_status_json(self) -> None:
        app_dir = self.fake_new / "05.Tooling" / "01.CodeXray"
        app_dir.mkdir(parents=True, exist_ok=True)
        for ro_cmd in (
            "opengrep scan --config auto .",
            "stylelint src/*.css",
            "markuplint src/index.html",
            "node --check app.js",
        ):
            r = _parse_json(
                project_lock.handle_pre_command(
                    {"conversationId": "conv-ro", "cwd": str(app_dir), "toolCall": {"args": {"CommandLine": ro_cmd}}}
                )
            )
            self.assertEqual(r["decision"], "allow", ro_cmd)
        self.assertEqual(lock_store.list_active_claims(), [])

        r_fix = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-fix",
                    "cwd": str(app_dir),
                    "toolCall": {"id": "tc-fix-1", "args": {"CommandLine": "npx stylelint --fix src/app.css"}},
                }
            )
        )
        self.assertEqual(r_fix["decision"], "allow")
        self.assertEqual(lock_store.list_active_claims()[0]["lockMode"], "FILE_WRITE")

        p_claim = self._run_cli(
            [
                "claim",
                "--conv-id",
                "swarm-tester",
                "--modules",
                "05.Tooling/01.CodeXray",
                "--mode",
                "test",
                "--json",
            ]
        )
        self.assertEqual(p_claim.returncode, 0, p_claim.stdout + p_claim.stderr)
        cdata = _parse_json(p_claim.stdout)
        self.assertTrue(cdata["acquired"])
        self.assertEqual(cdata["mode"], "TEST_SHARED")

        p_status = self._run_cli(["status", "--json"])
        self.assertEqual(p_status.returncode, 0)
        sdata = _parse_json(p_status.stdout)
        claims = cast(list[dict[str, object]], sdata["claims"])
        self.assertEqual(len(claims), 2)

    def _write_coordinator_transcript(self, coord_id: str, worker_ids: list[str]) -> Path:
        log_dir = self.fake_brain / coord_id / ".system_generated" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        tp = log_dir / "transcript.jsonl"
        lines: list[str] = []
        for idx, wid in enumerate(worker_ids, start=1):
            lines.append(
                json.dumps(
                    {
                        "type": "PLANNER_RESPONSE",
                        "source": "MODEL",
                        "tool_calls": [
                            {"name": "swarm", "args": {"action": '"add"', "name": f'"w{idx}"'}}
                        ],
                    }
                )
            )
            lines.append(
                json.dumps(
                    {
                        "type": "GENERIC",
                        "source": "MODEL",
                        "content": json.dumps(
                            {"status": "added", "name": f"w{idx}", "conversation_id": wid}
                        ),
                    }
                )
            )
        _ = tp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return tp

    def test_general_command_file_write_post_command_release_preserves_edit_claim(self) -> None:
        mod_dir = self.fake_new / "05.Tooling" / "01.CodeXray"
        other_dir = self.fake_new / "02.Libraries" / "SupportKit"
        mod_dir.mkdir(parents=True, exist_ok=True)
        other_dir.mkdir(parents=True, exist_ok=True)

        # Active edit_file claims keep clm: prefix and empty tool_call_id even if toolCall.id is given.
        res_other_edit = _parse_json(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-sess",
                    "toolCall": {"id": "tc-edit-other", "args": {"Path": str(other_dir / "Keep.cs")}},
                }
            )
        )
        res_same_mod_edit = _parse_json(
            project_lock.handle_pre_edit(
                {
                    "conversationId": "conv-sess",
                    "toolCall": {"id": "tc-edit-alpha", "args": {"Path": str(mod_dir / "Alpha.rs")}},
                }
            )
        )
        self.assertEqual(res_other_edit["decision"], "allow")
        self.assertEqual(res_same_mod_edit["decision"], "allow")

        res_cmd = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": "conv-sess",
                    "cwd": str(mod_dir),
                    "toolCall": {
                        "id": "tc-py-cmd-1",
                        "args": {"CommandLine": "python -c \"open('gen.txt', 'w').write('ok')\""},
                    },
                }
            )
        )
        self.assertEqual(res_cmd["decision"], "allow")

        claims_before = lock_store.list_active_claims()
        cmd_claims = [c for c in claims_before if str(c["claimId"]).startswith("cmd:")]
        clm_claims = [c for c in claims_before if str(c["claimId"]).startswith("clm:")]
        self.assertEqual(len(cmd_claims), 1)
        self.assertEqual(cmd_claims[0]["lockMode"], "FILE_WRITE")
        self.assertEqual(cmd_claims[0]["toolCallId"], "tc-py-cmd-1")
        self.assertEqual(cmd_claims[0]["fileRelpath"], "")
        self.assertEqual(len(clm_claims), 2)
        self.assertTrue(all(str(c["toolCallId"]) == "" for c in clm_claims))

        res_waiter = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-waiter", "toolCall": {"args": {"Path": str(mod_dir / "Beta.rs")}}}
            )
        )
        self.assertEqual(res_waiter["decision"], "deny")

        # PostToolUse for edit_file's ignored id must leave clm: claims untouched.
        _ = project_lock.handle_post_command(
            {"conversationId": "conv-sess", "toolCall": {"id": "tc-edit-alpha"}}
        )
        self.assertEqual(len(lock_store.list_active_claims()), 3)

        post_out = _parse_json(
            project_lock.handle_post_command(
                {"conversationId": "conv-sess", "toolCall": {"id": "tc-py-cmd-1"}}
            )
        )
        self.assertEqual(post_out, {})

        claims_after = lock_store.list_active_claims()
        by_owner_file = {
            (str(c["ownerId"]), str(c["moduleKey"]), str(c["fileRelpath"])): c for c in claims_after
        }
        self.assertEqual(len(claims_after), 3)
        self.assertIn(("conv-sess", "02.Libraries/SupportKit", "keep.cs"), by_owner_file)
        self.assertIn(("conv-sess", "05.Tooling/01.CodeXray", "alpha.rs"), by_owner_file)
        self.assertIn(("conv-waiter", "05.Tooling/01.CodeXray", "beta.rs"), by_owner_file)
        self.assertIsNone(by_owner_file[("conv-sess", "05.Tooling/01.CodeXray", "alpha.rs")]["reservedUntil"])
        self.assertIsNotNone(by_owner_file[("conv-waiter", "05.Tooling/01.CodeXray", "beta.rs")]["reservedUntil"])

    def test_symmetric_team_lineage_disjoint_and_serialized_and_deadlock(self) -> None:
        coord_id = "coord-team-sym"
        w1 = "worker-sym-1"
        w2 = "worker-sym-2"
        _ = self._write_coordinator_transcript(coord_id, [w1, w2])

        kit_dir = self.fake_new / "02.Libraries" / "SupportKit"
        xray_dir = self.fake_new / "05.Tooling" / "01.CodeXray"
        kit_dir.mkdir(parents=True, exist_ok=True)
        xray_dir.mkdir(parents=True, exist_ok=True)
        _ = (kit_dir / "SupportKit.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk" />\n', encoding="utf-8")

        # Coordinator C holds zero locks; siblings W1 & W2 edit disjoint files in same module concurrently.
        r_w1 = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": w1, "toolCall": {"args": {"Path": str(kit_dir / "PartOne.cs")}}}
            )
        )
        r_w2 = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": w2, "toolCall": {"args": {"Path": str(kit_dir / "PartTwo.cs")}}}
            )
        )
        self.assertEqual(r_w1["decision"], "allow")
        self.assertEqual(r_w2["decision"], "allow")

        with closing(sqlite3.connect(str(self.lock_dir / "locks.db"))) as conn:
            conn.row_factory = sqlite3.Row
            e1 = claim_store.get_lineage_entry_tx(conn, w1)
            e2 = claim_store.get_lineage_entry_tx(conn, w2)
            assert e1 is not None and e2 is not None
            self.assertEqual(e1["rootConvId"], coord_id)
            self.assertEqual(e2["rootConvId"], coord_id)

        # Siblings run TEST_SHARED concurrently without blocking.
        r_t1 = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": w1,
                    "cwd": str(kit_dir),
                    "toolCall": {"id": "tc-w1-test", "args": {"CommandLine": "dotnet test SupportKit.csproj --no-build"}},
                }
            )
        )
        r_t2 = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": w2,
                    "cwd": str(kit_dir),
                    "toolCall": {"id": "tc-w2-test", "args": {"CommandLine": "dotnet test SupportKit.csproj --no-build"}},
                }
            )
        )
        self.assertEqual(r_t1["decision"], "allow")
        self.assertEqual(r_t2["decision"], "allow")
        _ = project_lock.handle_post_command({"conversationId": w1, "toolCall": {"id": "tc-w1-test"}})
        _ = project_lock.handle_post_command({"conversationId": w2, "toolCall": {"id": "tc-w2-test"}})

        # Unrelated outsider is serialized WITHOUT the team protection hint.
        r_ext = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": "conv-outsider", "toolCall": {"args": {"Path": str(kit_dir / "PartOne.cs")}}}
            )
        )
        self.assertEqual(r_ext["decision"], "deny")
        self.assertNotIn("[같은 태스크 팀 보호:", str(r_ext["reason"]))

        # W2 editing W1's exact same file serializes with team protection hint.
        r_same_file = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": w2, "toolCall": {"args": {"Path": str(kit_dir / "PartOne.cs")}}}
            )
        )
        self.assertEqual(r_same_file["decision"], "deny")
        self.assertIn("[같은 태스크 팀 보호: 동일 파일/빌드 순서 대기]", str(r_same_file["reason"]))

        # True circular DEADLOCK_RISK between W1 <-> W2 (W2 waits on W1's PartOne.cs, W1 requests W2's PartTwo.cs).
        r_deadlock = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": w1, "toolCall": {"args": {"Path": str(kit_dir / "PartTwo.cs")}}}
            )
        )
        self.assertEqual(r_deadlock["decision"], "deny")
        self.assertIn("DEADLOCK_RISK", str(r_deadlock["reason"]))

        # W2 running BUILD_EXCL on a module held by W1 serializes with team protection hint.
        r_w1_xray = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": w1, "toolCall": {"args": {"Path": str(xray_dir / "Main.rs")}}}
            )
        )
        self.assertEqual(r_w1_xray["decision"], "allow")
        r_w2_build = _parse_json(
            project_lock.handle_pre_command(
                {
                    "conversationId": w2,
                    "cwd": str(xray_dir),
                    "toolCall": {"id": "tc-w2-bld", "args": {"CommandLine": "cargo build"}},
                }
            )
        )
        self.assertEqual(r_w2_build["decision"], "deny")
        self.assertIn("[같은 태스크 팀 보호: 동일 파일/빌드 순서 대기]", str(r_w2_build["reason"]))

    def test_per_worker_cap_eight_allows_more_than_eight_across_team(self) -> None:
        coord_id = "coord-cap-team"
        w1 = "worker-cap-1"
        w2 = "worker-cap-2"
        _ = self._write_coordinator_transcript(coord_id, [w1, w2])

        app_mods = [self.fake_new / "01.Apps" / f"Mod{idx:02d}" for idx in range(1, 15)]
        for idx in range(5):
            r1 = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": w1, "toolCall": {"args": {"Path": str(app_mods[idx] / "A.cs")}}}
                )
            )
            r2 = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": w2, "toolCall": {"args": {"Path": str(app_mods[idx + 5] / "B.cs")}}}
                )
            )
            self.assertEqual(r1["decision"], "allow")
            self.assertEqual(r2["decision"], "allow")

        # Team holds 5 + 5 = 10 > 8 distinct modules concurrently across siblings.
        self.assertEqual(len(lock_store.list_active_locks()), 10)

        # W1 expands to 8/8, then hits LIMIT_DENIED on 9th distinct module while W2 remains untouched.
        for idx in range(10, 13):
            r_more = _parse_json(
                project_lock.handle_pre_edit(
                    {"conversationId": w1, "toolCall": {"args": {"Path": str(app_mods[idx] / "A.cs")}}}
                )
            )
            self.assertEqual(r_more["decision"], "allow")

        r_ninth = _parse_json(
            project_lock.handle_pre_edit(
                {"conversationId": w1, "toolCall": {"args": {"Path": str(app_mods[13] / "A.cs")}}}
            )
        )
        self.assertEqual(r_ninth["decision"], "deny")
        self.assertIn("LIMIT_DENIED", str(r_ninth["reason"]))
        self.assertIn("8/8", str(r_ninth["reason"]))
        self.assertEqual(len(lock_store.list_active_locks()), 13)

    def test_legacy_lock_settings_cap_migration_once_and_preserves_custom(self) -> None:
        db_default = self.lock_dir / "locks.db"
        with closing(sqlite3.connect(str(db_default))) as conn:
            _ = conn.execute(
                "CREATE TABLE lock_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            _ = conn.execute(
                "INSERT INTO lock_settings (key, value) VALUES ('max_locks_per_session', '4')"
            )
            conn.commit()

        _ = lock_store.init_db()
        self.assertEqual(lock_store.get_guard_settings().max_locks_per_session, 8)
        self.assertEqual(lock_store.get_setting("max_locks_default_v2_8"), "1")

        # Once upgraded, subsequent init_db() respects an explicit override back to '4'.
        lock_store.set_setting("max_locks_per_session", "4")
        _ = lock_store.init_db()
        self.assertEqual(lock_store.get_guard_settings().max_locks_per_session, 4)

        custom_dir = (self.base / "custom_locks").resolve()
        custom_dir.mkdir(parents=True, exist_ok=True)
        custom_db = custom_dir / "locks.db"
        with closing(sqlite3.connect(str(custom_db))) as conn:
            _ = conn.execute(
                "CREATE TABLE lock_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            _ = conn.execute(
                "INSERT INTO lock_settings (key, value) VALUES ('max_locks_per_session', '6')"
            )
            conn.commit()

        with (
            mock.patch.object(lock_store, "LOCK_ROOT", custom_dir),
            mock.patch.object(lock_store, "LOCK_DB", custom_db),
            mock.patch.dict(os.environ, {"PROJECT_LOCK_DIR": str(custom_dir)}),
        ):
            _ = lock_store.init_db()
            self.assertEqual(lock_store.get_guard_settings().max_locks_per_session, 6)
            self.assertEqual(lock_store.get_setting("max_locks_default_v2_8"), "1")


if __name__ == "__main__":
    _ = unittest.main(verbosity=2)
