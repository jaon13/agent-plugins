# Antigravity Agent Plugins

Standalone Antigravity governance, build discipline, and concurrency-locking plugins designed to work cleanly alongside [`code-xray`](https://github.com/jaon13/code-xray) (or standalone in any multi-repo/polyglot workspace).

## Included Plugins

| Plugin | Icon | Purpose |
|---|---|---|
| `project-lock` | `plugins/project-lock/assets/logo.svg` | Module-granularity concurrency locking (`PreToolUse`/`Stop` hooks + SQLite WAL queue + Swarm `claim`/`release` CLI + `Lock & Tooling` Sidecar UI) |
| `dotnet-fast-execution` | `plugins/dotnet-fast-execution/assets/logo.svg` | Always-on `.NET` index-first navigation (`code-xray`), `-p:FastBuild=true` inner loops, non-polling rules, and Swarm/subagent brief sharding |
| `rust-governance` | `plugins/rust-governance/assets/logo.svg` | Always-on Rust workspace governance (`Cargo.toml` lints, profile-aware panic/unsafe/async gates, `cargo-deny`) and `Stop` consistency hook |

## Quick Install (1-Line Setup)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/jaon13/agent-plugins/main/install.ps1 | iex
```

**macOS / Linux (Bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/jaon13/agent-plugins/main/install.sh | bash
```

**Install both `agent-plugins` + `code-xray` together:**
```powershell
# Windows
$env:WITH_CODE_XRAY='1'; irm https://raw.githubusercontent.com/jaon13/agent-plugins/main/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/jaon13/agent-plugins/main/install.sh | bash -s -- --with-code-xray
```

**From a local clone:**
```bash
python scripts/install_plugins.py --enable
```

If `agy` CLI is not on `PATH`, enable the installed plugins inside Antigravity via the **Plugins Manager UI** or `/plugin` (never hand-edit `~/.gemini/config/config.json`).

Validate locally with:

```bash
agy plugin validate ~/.gemini/config/plugins/project-lock
agy plugin validate ~/.gemini/config/plugins/dotnet-fast-execution
agy plugin validate ~/.gemini/config/plugins/rust-governance
```

## Optional Monorepo Configuration (`~/.agents/locks/config.json`)

By default, `project-lock` detects Git repositories and project manifests (`Cargo.toml`, `package.json`, `pyproject.toml`, `*.csproj`, `*.slnx`) automatically with **zero hardcoded paths**.

For multi-repo / monorepo layouts with shared libraries and upper applications, copy [examples/locks-config.example.json](./examples/locks-config.example.json) to `~/.agents/locks/config.json` (or run `python scripts/install_plugins.py --init-config`, or point `PROJECT_LOCK_CONFIG` to a custom file) and customize `workspaceRoot`, `sharedSrcGroups`, `sharedGroups`, and `appGroups`.

## Swarm Coordinator Integration (`claim` / `release`)

Because Swarm workers can run outside interactive editor hooks, coordinators reserve and release disjoint module slices explicitly:

```bash
python ~/.gemini/config/plugins/project-lock/scripts/project_lock.py status
python ~/.gemini/config/plugins/project-lock/scripts/project_lock.py claim --conv-id <worker-id> --modules mod-a,mod-b --workspace <path> --tag swarm
# ... worker executes ...
python ~/.gemini/config/plugins/project-lock/scripts/project_lock.py release --conv-id <worker-id>
```

## Running Tests

```bash
python -m pytest plugins/project-lock/tests -v
node --test plugins/project-lock/sidecars/lock_board/tests/lock_board.test.mjs
python -m ruff check plugins/project-lock/scripts plugins/project-lock/tests scripts
```
