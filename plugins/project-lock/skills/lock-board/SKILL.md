---
name: lock-board
description: Open the Lock & Tooling sidecar panel quickly and inspect live ProjectLock active locks, FIFO wait queue, Next Up sessions, and recent release/wake events. Trigger on `/lock-board` or requests to open the lock/tooling panel.
---

# Lock & Tooling Quick Launcher (`/lock-board`)

1. Run the live queue inspection command:
   ```powershell
   python "$HOME/.gemini/config/plugins/project-lock/scripts/project_lock.py" queue
   ```
2. Always include the clickable sidecar link prominently in your reply so the user can open/focus the panel in one click:
   `[Lock & Tooling](sidecar://project-lock/lock_board/)`
3. Present a concise summary:
   - **Active Locks**: module, owner session title + short ID, elapsed time, and `next` waiting session if any.
   - **Next Up / FIFO Queue**: highlight promoted (`[NEXT UP]`) or `#1` waiting sessions with their wake status (`sent` / `pending` / `failed`).
   - **Recent Release & Wake Events**: highlight any `RELEASE`, `PROMOTED`, `WAKE_SENT`, `WAKE_DEFERRED`, or `WAKE_FAILED`.
   - If the sidecar panel does not respond or needs a reload after plugin updates, include `[project-lock](customization://project-lock)` so the user can toggle/reload it cleanly.
