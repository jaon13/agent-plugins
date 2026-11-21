# Project-Unit Concurrency Lock & Shared Build Rules

Global lock directory: `~/.agents/locks/` (optional monorepo group config: `~/.agents/locks/config.json`).

1. **Module-Unit & Option C Balanced Locking (`PreToolUse` / `PostToolUse` / `Stop`)**:
   - Every file edit (`write_file`, `edit_file`) and mutating/build/test command (`run_command`) claims at **module granularity** (git/manifest repo roots by default, or monorepo group rules from `~/.agents/locks/config.json` / `PROJECT_LOCK_CONFIG`).
   - `edit_file` / `write_file` hold per-file **`FILE_WRITE`** claims until turn **`Stop`** (`fullyIdle: true`; safety TTL: 20 minutes).
   - General `run_command` claims act as short-lived **`PostToolUse` barriers** (alongside **`TEST_SHARED`** for `--no-build` tests and **`BUILD_EXCL`** for builds) and release immediately when the command finishes.
   - **Symmetric Team Lineage (`root_conv_id`)**: Coordinator and subagent sessions sharing a `root_conv_id` may edit **disjoint files** and run **`--no-build` tests** in parallel, while **same-file edits** and **`BUILD_EXCL` builds** remain serialized (`deny`). Do **not** bypass locks via shell commands; wait for the owner or ask the user.
   - **Read-Only Inspection**: Use strictly read-only commands and loops (e.g., `git status`/`ls-remote`/`rev-list`, `docker compose config`/`ps`, PowerShell `foreach`/`try`/`if` wrapping read-only commands) so only actual edits, builds, or tests acquire locks.

2. **Swarm Explicit Module Claim / Release (`claim` / `release`)**:
   - Because Swarm workers may execute outside standard interactive hook turns, Swarm coordinators MUST run:
     - `python "<plugin_dir>/scripts/project_lock.py" status` before fanning out writers;
     - `python "<plugin_dir>/scripts/project_lock.py" claim --conv-id <worker-id> --modules <mod1,mod2> --workspace <path> --tag swarm` to reserve non-overlapping module locks per worker;
     - `python "<plugin_dir>/scripts/project_lock.py" release --conv-id <worker-id>` immediately when the worker finishes or is killed.

3. **Per-Worker/Session 8-Lock Ceiling (`LIMIT_DENIED`)**:
   - Concurrent module ceiling: **max 8 modules per worker/session** (`LIMIT_DENIED` — counted per worker/session rather than combined across a coordinator+subagent tree, with **no** blanket `.slnx` exemption). Re-acquiring already-held modules stays allowed; new modules past 8 are denied without queueing.
   - Keep each turn or `/swarm` worker ideally scoped to **1–2 modules** per slice (`<= 8` hard cap). Build large multi-module solutions by affected `.csproj` targets or `<= 8`-module batches, and split large refactors across sequential turns or `/swarm` workers.

4. **Upper-App Builds & Dependency Cascade Guard (`DEP_GUARD_DENIED`)**:
   - When building or testing upper-layer solutions, pass **`--no-dependencies`** (or `-p:BuildProjectReferences=false` / `--no-build` for test-only runs) unless intentionally rebuilding modified shared libraries.
   - Any build/test pulling **>= 3** external shared modules without `--no-dependencies` / `-p:BuildProjectReferences=false` / `--no-build` is immediately blocked (`DEP_GUARD_DENIED`, no queue entry). Build modified shared modules separately in `<= 8`-module batches first, then build the upper app with `--no-dependencies`.
   - This prevents cross-task DLL overwrites and `MSB3027` file-lock errors (e.g. `CodeXrayMcp` locking shared generator DLLs).

5. **Turn-End Lock Report (Only When Locks Were Used or Blocked)**:
   - On pure read-only / Q&A turns with no edits or builds, say nothing about locks.
   - **ONLY** when this turn acquired a module lock (file edit or build) or encountered a lock `deny`, append **one concise line** at the end of your final answer:
     - Normal release at turn end: `🔓 [ProjectLock] 턴 종료 후 자동 해제 예정: <module1>, <module2>` (if a shared module has uncommitted changes, add `⚠️ 미커밋 변경 유지 중`)
     - Blocked by another session: `🔒 [ProjectLock] 차단됨: <module> (점유: <ownerShort> — /project-lock 으로 확인/해제 가능)`
