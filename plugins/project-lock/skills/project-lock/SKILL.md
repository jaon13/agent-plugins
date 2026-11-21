---
name: project-lock
description: >-
  Inspect, verify, queue, claim, or release module-unit concurrency locks under
  ~/.agents/locks/locks.db (SQLite WAL). Use when a tool call is blocked by
  ProjectLock (conflict, DEADLOCK_RISK, LIMIT_DENIED, or DEP_GUARD_DENIED), when
  the user invokes /project-lock, when coordinating Swarm module claims, or when
  checking active locks, FIFO wait queues, and auto-wakeup status.
---

# Project Lock Inspector (`/project-lock`)

Manage active module locks, Swarm module reservations, FIFO wait queues, and event history stored in `~/.agents/locks/locks.db` (SQLite WAL, optional monorepo workspace rules in `~/.agents/locks/config.json`).

Open live visual panel: [Lock & Tooling](sidecar://project-lock/lock_board/)

## Commands

Run via `run_command` (replace `<plugin_scripts>` with this plugin's `scripts/` directory):

```powershell
# 1. List all active locks (module, owner, idle/TTL, 60s reservation, git dirty status)
python "<plugin_scripts>/project_lock.py" status
python "<plugin_scripts>/project_lock.py" status --json

# 2. List active locks + FIFO wait queue + recent lock/wake events (+ --json with ownerLockCount/maxLocksPerSession)
python "<plugin_scripts>/project_lock.py" queue
python "<plugin_scripts>/project_lock.py" queue --json

# 3. Swarm coordinator explicit module reservation & release
python "<plugin_scripts>/project_lock.py" claim --conv-id "<worker-id>" --modules "<mod1,mod2>" --workspace "<repo>" --tag swarm --json
python "<plugin_scripts>/project_lock.py" release --conv-id "<worker-id>" --json

# 4. Release a specific module lock, expired locks, or all locks
python "<plugin_scripts>/project_lock.py" unlock --module "<moduleKey>"
python "<plugin_scripts>/project_lock.py" unlock --expired
python "<plugin_scripts>/project_lock.py" unlock --all
```

## Concurrency, Queue & Guard Behavior

- **Option C Balanced Claim Lifecycles (`FILE_WRITE`, `TEST_SHARED`, `BUILD_EXCL`)**:
  - `edit_file` / `write_file` hold per-file `FILE_WRITE` claims until `Stop` (`fullyIdle: true`; fallback TTL 20m).
  - General `run_command` claims act as short-lived `PostToolUse` barriers alongside `TEST_SHARED` (`--no-build` test runs) and `BUILD_EXCL` (exclusive builds), releasing immediately when the command completes.
- **Symmetric Team Lineage (`root_conv_id`)**: Coordinator and subagent sessions sharing a `root_conv_id` may edit disjoint files (`FILE_WRITE`) and run `--no-build` tests (`TEST_SHARED`) in parallel while still serializing same-file edits and `BUILD_EXCL` builds.
- **Atomic Multi-Module Queue Groups**: If any module required by a command is locked by another session, **no partial locks** are taken on free modules; all targets are queued together under one `request_group_id`.
- **Wait-For Graph Deadlock Guard (`DEADLOCK_RISK`)**: If the blocking owner is already waiting on a module held by the requesting session, `PreToolUse` denies immediately with `DEADLOCK_RISK` without queueing into a cycle.
- **Per-Worker/Session 8-Lock Ceiling (`LIMIT_DENIED`)**: Counted **per worker/session** rather than combined across a coordinator+subagent tree, capped at `max_locks_per_session` active modules (default `8`) with **no** blanket `.slnx` exemption. Recommend **1–2 modules** per slice (`<= 8` hard cap); re-acquiring or re-editing already-held modules remains allowed even at `8/8`.
- **Upper-App Dependency Cascade Guard (`DEP_GUARD_DENIED`)**: Any `dotnet` build/test command pulling `>= max_shared_deps_without_nodeps` (default `3`) external shared modules without `--no-dependencies`, `-p:BuildProjectReferences=false`, or `--no-build` is immediately denied **without** queueing.
- **Read-Only Command & Loop Exemption**: Pure read-only commands (`git status`/`ls-remote`/`rev-list`, `docker compose config`/`ps`, `project_lock.py status|queue|claim|release`) and safe PowerShell inspection blocks acquire **0** extra hook locks.
- **60s Reservation & Auto-Wake**: On `Stop` (`fullyIdle: true`), `release`, or `unlock`, the #1 ready waiter group receives a 60s `reserved_until` token and CLI `agentapi send-message` wakes Antigravity sessions when `auto_wake_enabled='1'`.

## Workspace Configuration (`~/.agents/locks/config.json`)

To customize monorepo shared/app group detection beyond standalone git/manifest roots, create `~/.agents/locks/config.json` (or set `PROJECT_LOCK_CONFIG`):
- `workspaceRoot`: root path containing monorepo groups
- `sharedSrcGroups`: group folder names with `<group>/src/<module>` layout (shared = true)
- `sharedGroups`: group folder names with `<group>/<module>` layout (shared = true)
- `appGroups`: group folder names with `<group>/<app>` layout (shared = false)
- `osLockChecks`: optional `[{ "moduleKey": "...", "dllRelPath": "..." }]` checked before cascade builds

## Guard Settings (`lock_settings` in `locks.db`)

| `lock_settings` Key | Default | Meaning |
| --- | --- | --- |
| `max_locks_per_session` | `'8'` | Maximum simultaneously active module locks per worker/session (`LIMIT_DENIED` above cap) |
| `max_shared_deps_without_nodeps` | `'3'` | External shared module threshold triggering `DEP_GUARD_DENIED` without `--no-dependencies` |
| `auto_wake_enabled` | `'1'` | Auto-promote and wake `#1` waiter on `Stop` / `release` / `unlock` (`'1'` enabled, `'0'` disabled) |

## Rules

- Never forcefully unlock another active session's module unless the user explicitly confirms the other task is idle/finished or crashed.
- Present `status` / `queue` output concisely in a small Markdown table (`모듈 | 점유 세션 | 경과/예약 | 상태 | 대기열`).
