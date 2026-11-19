# Rust Idiomatic Static Analysis & Governance Rules

Enforce these rules across all Rust workspaces and standalone crates (`Cargo.toml`):

1. **Compiler & Cargo as Single Source of Truth**:
   - Ensure workspaces/crates have `deny.toml`, `rustfmt.toml`, `clippy.toml` (`allow-unwrap-in-tests = true`), and `[workspace.lints]` / `[lints]` configured. Bootstrap missing repos via:
     `python "$HOME/.agents/bin/xray_run.py" init_rust_governance.py --repo-root "<repo>"`
2. **Profile-Aware Errors vs Invariants**:
   - **All profiles**: Never use `.unwrap()`, `todo!()`, `unimplemented!()`, or `dbg!()` in production code.
   - **`ffi` (`cdylib` / `staticlib`)**: Strictly ban `.expect()`, `panic!()`, `println!()`, and `eprintln!()` (`panic=abort` / ABI safety).
   - **`server-async` (`tokio`/`axum`/`tauri`) & `cli-lib`**: Propagate errors via `Result`/`?`. Reserve `.expect()` strictly for compile-time or boot invariants and annotate with `#[expect(clippy::expect_used, reason = "...")]`.
   - **No silent `let _ =` swallowing**: Do not silence `#[must_use]` `Result`/cleanup errors with bare `let _ = ...`; propagate, log (`if let Err(e)`), or justify intentional drops with `#[expect(clippy::let_underscore_must_use, reason = "...")]`.
3. **Explicit `unsafe` Safety & Async Concurrency**:
   - Every `unsafe { ... }` block must have an adjacent `// SAFETY: ...` justification; every `unsafe fn` needs `# Safety` docs.
   - Never hold `std::sync::Mutex` / `RwLock` guards across `.await` (`await_holding_lock = "deny"`).
4. **Cohesion & Verification Gates**:
   - Keep `#[cfg(test)] mod tests` inline when testing private internals; prefer Clippy function/complexity budgets over arbitrary whole-file line splits.
   - Run `python "$HOME/.agents/bin/xray_run.py" check_consistency.py --repo-root "<repo>"` during iteration and `python "$HOME/.agents/bin/xray_run.py" verify_rust.py --repo-root "<repo>"` before declaring Rust work complete.
