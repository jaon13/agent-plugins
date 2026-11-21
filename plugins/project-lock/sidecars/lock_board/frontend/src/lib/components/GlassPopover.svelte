<script lang="ts">
  import { formatAgeSeconds } from '../domain/boardPure.ts';
  import type { BoardTask } from '../types/board.ts';

  interface Props {
    task: BoardTask;
    alignRight?: boolean;
    onOpenSession: () => void;
    onUnlockModule: (modKey: string) => void;
    onClose: () => void;
  }

  let { task, alignRight = false, onOpenSession, onUnlockModule, onClose }: Props = $props();
</script>

<div
  class={alignRight ? 'glass-popover align-right' : 'glass-popover'}
  role="dialog"
  aria-label={`Details for ${task.title}`}
>
  <div class="pop-head">
    <div class="pop-title-col">
      <div class="pop-title">{task.title}</div>
      <div class="muted mono">{task.id.slice(0, 12)} · {task.workspaceName || 'Workspace'}</div>
    </div>
    <button type="button" class="pop-close" aria-label="Close popover" onclick={onClose}>
      ×
    </button>
  </div>

  {#if task.blockedReason}
    <div class="pop-alert">{task.blockedReason}</div>
  {/if}

  {#if task.heldFiles.length > 0}
    <div class="pop-section">
      <div class="pop-label">Where &amp; Granular Locks</div>
      <ul class="pop-list">
        {#each task.heldFiles.slice(0, 5) as claim (`${claim.moduleKey}:${claim.lockMode}:${claim.fileRelpath}`)}
          <li class="claim-item">
            <span class="pill pill-doing">{claim.lockMode}</span>
            <span class="mono claim-path">
              {claim.moduleKey}{claim.fileRelpath ? `/${claim.fileRelpath}` : ''}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if task.todos.length > 0}
    <div class="pop-section">
      <div class="pop-label">
        Checklist ({task.todoCounts.done}/{task.todoCounts.total})
      </div>
      <ul class="pop-list">
        {#each task.todos.slice(0, 7) as item, idx (`${idx}:${item.text}`)}
          <li class="todo-item">
            <span class={`todo-mark ${item.state}`} aria-hidden="true">
              {item.state === 'done' ? '✓' : item.state === 'doing' ? '◐' : '○'}
            </span>
            <span class={item.state === 'done' ? 'todo-text done' : 'todo-text'}>{item.text}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="pop-foot">
    <span class="muted">
      {task.subagentCount > 0 ? `${task.subagentCount} subagents · ` : ''}idle {formatAgeSeconds(task.idleSeconds)}
    </span>
    <div class="pop-actions">
      <button type="button" class="btn" onclick={onOpenSession}>Jump</button>
      {#if task.modules.length > 0 && task.heldFiles.length > 0}
        <button
          type="button"
          class="btn btn-danger"
          onclick={() => { onUnlockModule(task.modules[0]); }}
        >
          Unlock
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .glass-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: var(--z-popover);
    width: min(320px, 90vw);
    padding: 12px;
    border-radius: var(--radius-popover);
    background-color: var(--bg-glass);
    backdrop-filter: blur(22px) saturate(1.6);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-popover);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .glass-popover.align-right {
    left: auto;
    right: 0;
  }

  .pop-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .pop-title-col {
    min-width: 0;
  }

  .pop-title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .pop-close {
    border: 0;
    background-color: transparent;
    color: var(--text-muted);
    font-size: var(--fs-title);
    line-height: 1;
    padding: 0 4px;
  }

  .pop-alert {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background-color: var(--status-blocked-soft);
    color: var(--status-blocked);
    font-size: var(--fs-xs);
  }

  .pop-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .pop-label {
    font-size: var(--fs-2xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    font-weight: 600;
  }

  .pop-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .claim-item,
  .todo-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-xs);
    min-width: 0;
  }

  .claim-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
  }

  .todo-mark {
    width: 14px;
    text-align: center;
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .todo-mark.doing {
    color: var(--status-doing);
  }

  .todo-mark.done {
    color: var(--status-done);
  }

  .todo-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .todo-text.done {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  .pop-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--border-hairline);
  }

  .pop-actions {
    display: flex;
    gap: 6px;
  }
</style>
