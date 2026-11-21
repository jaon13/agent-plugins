<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { formatAgeSeconds, shortConvId } from '../domain/boardPure.ts';
  import type { ClaimItem, EventItem, LockItem, QueueItem } from '../types/board.ts';

  interface Props {
    locks: readonly LockItem[];
    claims: readonly ClaimItem[];
    queue: readonly QueueItem[];
    events: readonly EventItem[];
    autoWakeEnabled: boolean;
    maxLocksPerSession: number;
    maxSharedDeps: number;
    busy: boolean;
    onToggleAutoWake: (enabled: boolean) => void;
    onUnlockExpired: () => void;
    onUnlockModule: (moduleKey: string) => void;
    onWakeNow: (id: number) => void;
    onCancelQueue: (id: number) => void;
    onOpenSession: (convId: string) => void;
  }

  let {
    locks,
    claims,
    queue,
    events,
    autoWakeEnabled,
    maxLocksPerSession,
    maxSharedDeps,
    busy,
    onToggleAutoWake,
    onUnlockExpired,
    onUnlockModule,
    onWakeNow,
    onCancelQueue,
    onOpenSession,
  }: Props = $props();

  let showEvents = $state(false);

  const claimsByMod = $derived.by(() => {
    const map = new SvelteMap<string, ClaimItem[]>();
    for (const c of claims) {
      const list = map.get(c.moduleKey);
      if (list) list.push(c);
      else map.set(c.moduleKey, [c]);
    }
    return map;
  });

  function claimBadgeClass(mode: string): string {
    if (mode === 'TEST_SHARED') return 'pill pill-done';
    if (mode === 'FILE_WRITE') return 'pill pill-doing';
    return 'pill pill-warn';
  }
</script>

<section class="locks-wrap" aria-label="Locks and queue panel">
  <div class="surface-card controls-bar">
    <div class="controls-meta">
      <span class="pill">Cap {maxLocksPerSession} modules/session</span>
      <span class="pill">Cascade &gt;= {maxSharedDeps} `--no-deps`</span>
    </div>
    <div class="controls-btns">
      <button
        type="button"
        class={autoWakeEnabled ? 'btn btn-accent' : 'btn'}
        disabled={busy}
        onclick={() => { onToggleAutoWake(!autoWakeEnabled); }}
      >
        Auto-Wake: {autoWakeEnabled ? 'ON' : 'OFF'}
      </button>
      <button type="button" class="btn" disabled={busy} onclick={onUnlockExpired}>
        Sweep Expired
      </button>
    </div>
  </div>

  <div class="two-col">
    <div class="surface-card stack">
      <div class="panel-head">
        <h2 class="panel-title">Active Modules &amp; Claims ({claims.length})</h2>
      </div>
      {#if locks.length === 0 && claims.length === 0}
        <p class="muted">No active locks held across sessions.</p>
      {:else}
        {#each locks as lk (lk.moduleKey)}
          {@const modClaims = claimsByMod.get(lk.moduleKey) || []}
          <div class="lock-row">
            <div class="row-top">
              <span class="mono lock-mod">{lk.moduleKey}</span>
              <div class="row-actions">
                <button type="button" class="btn" onclick={() => { onOpenSession(lk.ownerId); }}>
                  Open
                </button>
                <button
                  type="button"
                  class="btn btn-danger"
                  disabled={busy}
                  onclick={() => { onUnlockModule(lk.moduleKey); }}
                >
                  Unlock
                </button>
              </div>
            </div>
            <div class="muted row-sub">
              <span>{lk.ownerTitle || shortConvId(lk.ownerId)}</span>
              <span>idle {formatAgeSeconds(lk.idleSeconds)}</span>
              {#if (lk.ownerLockCount ?? 0) >= (lk.maxLocksPerSession ?? maxLocksPerSession)}
                <span class="pill pill-warn quota-badge">
                  {lk.ownerLockCount}/{lk.maxLocksPerSession ?? maxLocksPerSession}
                </span>
              {/if}
              {#if lk.activity?.status === 'stalled' || lk.activity?.status === 'stale'}
                <span class="pill pill-blocked">{lk.activity.status}</span>
              {/if}
              {#if lk.isReserved}
                <span class="pill pill-warn">reserved {lk.reservedRemainingSeconds}s</span>
              {/if}
            </div>
            {#if modClaims.length > 0}
              <div class="claims-list">
                {#each modClaims as cl (cl.claimId)}
                  <span class={claimBadgeClass(cl.lockMode)}>
                    {cl.lockMode}{cl.fileRelpath ? `: ${cl.fileRelpath}` : ''}
                    ({shortConvId(cl.ownerId)})
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <div class="surface-card stack">
      <div class="panel-head">
        <h2 class="panel-title">Wait Queue ({queue.length})</h2>
      </div>
      {#if queue.length === 0}
        <p class="muted">Wait queue is empty.</p>
      {:else}
        {#each queue as q (q.id)}
          <div class="lock-row">
            <div class="row-top">
              <span class="mono lock-mod">
                {q.status === 'promoted' ? 'NEXT UP' : `#${q.position}`} · {q.moduleKey}
              </span>
              <div class="row-actions">
                {#if q.status === 'promoted'}
                  <button type="button" class="btn btn-accent" disabled={busy} onclick={() => { onWakeNow(q.id); }}>
                    Wake Now
                  </button>
                {/if}
                <button type="button" class="btn" disabled={busy} onclick={() => { onCancelQueue(q.id); }}>
                  Cancel
                </button>
              </div>
            </div>
            <div class="muted row-sub">
              <span>{q.waiterTitle || shortConvId(q.waiterConvId)}</span>
              <span>{q.lockMode || 'BUILD_EXCL'}{q.fileRelpath ? `:${q.fileRelpath}` : ''}</span>
              <span>wake={q.wakeStatus}</span>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div class="surface-card">
    <div class="panel-head">
      <h2 class="panel-title">Recent Lock Events ({events.length})</h2>
      <button type="button" class="btn" onclick={() => { showEvents = !showEvents; }}>
        {showEvents ? 'Hide' : 'Show'}
      </button>
    </div>
    {#if showEvents}
      {#if events.length === 0}
        <p class="muted">No lock events recorded.</p>
      {:else}
        <div class="events-list">
          {#each events.slice(0, 15) as ev (ev.id)}
            <div class="event-row mono">
              <span class="pill">{ev.event}</span>
              <span>{ev.moduleKey || 'system'}</span>
              <span class="muted">{ev.convTitle || shortConvId(ev.convId)} {ev.detail}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .locks-wrap,
  .stack,
  .events-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .controls-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .controls-meta,
  .controls-btns,
  .row-actions,
  .claims-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .lock-row {
    padding: 9px 10px;
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-sm);
    background-color: var(--bg-subtle);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .lock-mod {
    color: var(--text-primary);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .event-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border-hairline);
  }

  .quota-badge {
    font-weight: 600;
  }
</style>
