<script lang="ts">
  import { formatAgeSeconds } from '../domain/boardPure.ts';
  import type { BoardTask } from '../types/board.ts';
  import GlassPopover from './GlassPopover.svelte';

  interface Props {
    task: BoardTask;
    inspected: boolean;
    pinned: boolean;
    popRightEdge?: boolean;
    onHoverStart: () => void;
    onHoverEnd: () => void;
    onDismiss: () => void;
    onTogglePin: () => void;
    onOpenSession: (id: string) => void;
    onUnlockModule: (modKey: string) => void;
  }

  let {
    task,
    inspected,
    pinned,
    popRightEdge = false,
    onHoverStart,
    onHoverEnd,
    onDismiss,
    onTogglePin,
    onOpenSession,
    onUnlockModule,
  }: Props = $props();

  const statusDotClass = $derived(
    task.status === 'blocked'
      ? 'dot-blocked'
      : task.status === 'in_progress'
        ? 'dot-doing'
        : task.status === 'done'
          ? 'dot-done'
          : 'dot-todo'
  );

  const badgeText = $derived(
    task.todoCounts.total > 0
      ? `${task.todoCounts.done}/${task.todoCounts.total}`
      : task.heldFiles.length > 1
        ? `${task.heldFiles.length} files`
        : task.lockModes[0] || formatAgeSeconds(task.idleSeconds)
  );
</script>

<div
  class="card-slot"
  role="group"
  aria-label={task.title}
  onmouseenter={onHoverStart}
  onmouseleave={onHoverEnd}
  onfocusin={onHoverStart}
  onfocusout={onHoverEnd}
>
  <button
    type="button"
    class={pinned ? 'task-card pinned' : 'task-card'}
    aria-expanded={inspected}
    aria-label={`Inspect task ${task.title}`}
    onclick={onTogglePin}
  >
    <span class="card-row">
      <span class={`status-dot ${statusDotClass}`}></span>
      <span class="card-title">{task.title}</span>
      <span class="card-ratio">{badgeText}</span>
    </span>
    <span class="card-meta">
      <span class="card-where mono">{task.where}</span>
      <span class="card-id mono">{task.shortId}</span>
    </span>
  </button>

  {#if inspected}
    <GlassPopover
      {task}
      alignRight={popRightEdge}
      onOpenSession={() => { onOpenSession(task.id); }}
      onUnlockModule={(modKey: string) => { onUnlockModule(modKey); }}
      onClose={onDismiss}
    />
  {/if}
</div>

<style>
  .card-slot {
    position: relative;
    min-width: 0;
  }

  .task-card {
    width: 100%;
    min-width: 0;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 9px 10px;
    background-color: var(--bg-surface);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
    transition: border-color 130ms ease, background-color 130ms ease;
  }

  .task-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .task-card:hover,
  .task-card.pinned {
    background-color: var(--bg-elevated);
    border-color: var(--border-strong);
  }

  .card-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-pill);
    flex-shrink: 0;
    background-color: var(--status-todo);
  }

  .dot-doing {
    background-color: var(--status-doing);
  }

  .dot-blocked {
    background-color: var(--status-blocked);
  }

  .dot-done {
    background-color: var(--status-done);
  }

  .card-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .card-ratio {
    flex-shrink: 0;
    font-size: var(--fs-2xs);
    color: var(--text-secondary);
    background-color: var(--bg-subtle);
    padding: 1px 6px;
    border-radius: var(--radius-pill);
  }

  .card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .card-where {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
    font-size: var(--fs-xs);
  }

  .card-id {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--fs-2xs);
  }
</style>
