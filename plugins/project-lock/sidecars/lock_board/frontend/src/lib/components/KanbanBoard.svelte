<script lang="ts">
  import { groupTasksByColumn } from '../domain/boardPure.ts';
  import type { BoardCounts, BoardFilter, BoardStatus, BoardTask } from '../types/board.ts';
  import TaskCard from './TaskCard.svelte';

  interface Props {
    tasks: ReadonlyArray<BoardTask>;
    counts: BoardCounts;
    filter: BoardFilter;
    inspectedId: string | null;
    pinnedId: string | null;
    onFilterChange: (f: BoardFilter) => void;
    onHover: (id: string | null) => void;
    onDismiss: () => void;
    onTogglePin: (id: string) => void;
    onOpenSession: (id: string) => void;
    onUnlockModule: (modKey: string) => void;
  }

  let {
    tasks,
    counts,
    filter,
    inspectedId,
    pinnedId,
    onFilterChange,
    onHover,
    onDismiss,
    onTogglePin,
    onOpenSession,
    onUnlockModule,
  }: Props = $props();

  const buckets = $derived(groupTasksByColumn(tasks));

  const columns: ReadonlyArray<{
    readonly id: BoardStatus;
    readonly label: string;
    readonly count: number;
    readonly items: readonly BoardTask[];
    readonly rightEdge: boolean;
  }> = $derived([
    { id: 'todo', label: 'Todo', count: counts.todo, items: buckets.todo, rightEdge: false },
    { id: 'in_progress', label: 'In Progress', count: counts.in_progress, items: buckets.in_progress, rightEdge: false },
    { id: 'blocked', label: 'Blocked', count: counts.blocked, items: buckets.blocked, rightEdge: true },
    { id: 'done', label: 'Done', count: counts.done, items: buckets.done, rightEdge: true },
  ]);

  const filterButtons: ReadonlyArray<{ readonly id: BoardFilter; readonly label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'todo', label: 'Todo' },
    { id: 'in_progress', label: 'Progress' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'done', label: 'Done' },
  ];
</script>

<section class="board-wrap" aria-label="Live session Kanban board">
  <div class="board-bar">
    <span class="muted">Auto-projected from local telemetry · hover or tap any card</span>
    <div class="segmented narrow-filters" role="group" aria-label="Column filter">
      {#each filterButtons as fb (fb.id)}
        <button
          type="button"
          class={filter === fb.id ? 'seg-btn active' : 'seg-btn'}
          onclick={() => { onFilterChange(fb.id); }}
        >
          {fb.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="kanban-grid">
    {#each columns as col (col.id)}
      <div class={filter !== 'all' && filter !== col.id ? 'kanban-col hidden-narrow' : 'kanban-col'}>
        <div class="col-head">
          <span class="col-name">{col.label}</span>
          <span class="pill">{col.count}</span>
        </div>
        <div class="col-stack">
          {#if col.items.length === 0}
            <div class="empty-col">Empty</div>
          {:else}
            {#each col.items as task (task.id)}
              <TaskCard
                {task}
                inspected={inspectedId === task.id}
                pinned={pinnedId === task.id}
                popRightEdge={col.rightEdge}
                onHoverStart={() => { onHover(task.id); }}
                onHoverEnd={() => { onHover(null); }}
                {onDismiss}
                onTogglePin={() => { onTogglePin(task.id); }}
                {onOpenSession}
                {onUnlockModule}
              />
            {/each}
          {/if}
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .board-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .board-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .kanban-col {
    background-color: var(--bg-subtle);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-card);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 110px;
    min-width: 0;
  }

  .col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .col-name {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .col-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .empty-col {
    padding: 18px 8px;
    text-align: center;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }

  .hidden-narrow {
    display: none;
  }

  @container shell (min-width: 840px) {
    .narrow-filters {
      display: none;
    }

    .hidden-narrow {
      display: flex;
    }
  }
</style>
