<script lang="ts">
  import type { TabId } from '../types/board.ts';

  interface Props {
    activeTab: TabId;
    lockCount: number;
    claimCount: number;
    boardCount: number;
    pollError: string;
    loading: boolean;
    onSelectTab: (tab: TabId) => void;
    onRefresh: () => void;
  }

  let {
    activeTab,
    lockCount,
    claimCount,
    boardCount,
    pollError,
    loading,
    onSelectTab,
    onRefresh,
  }: Props = $props();
</script>

<header class="topbar">
  <div class="brand">
    <span class={pollError ? 'live-dot error' : 'live-dot'} aria-hidden="true"></span>
    <h1 class="brand-title">Lock &amp; Tooling</h1>
    <span class="pill brand-pill" title="Active locks / claims">
      {claimCount > lockCount ? `${lockCount} mod · ${claimCount} claims` : `${lockCount} locks`}
    </span>
  </div>

  <nav class="segmented" aria-label="Primary sections">
    <button
      type="button"
      class={activeTab === 'board' ? 'seg-btn active' : 'seg-btn'}
      aria-current={activeTab === 'board' ? 'page' : undefined}
      onclick={() => { onSelectTab('board'); }}
    >
      Board ({boardCount})
    </button>
    <button
      type="button"
      class={activeTab === 'locks' ? 'seg-btn active' : 'seg-btn'}
      aria-current={activeTab === 'locks' ? 'page' : undefined}
      onclick={() => { onSelectTab('locks'); }}
    >
      Locks ({claimCount})
    </button>
    <button
      type="button"
      class={activeTab === 'xray' ? 'seg-btn active' : 'seg-btn'}
      aria-current={activeTab === 'xray' ? 'page' : undefined}
      onclick={() => { onSelectTab('xray'); }}
    >
      X-Ray
    </button>
  </nav>

  <button
    type="button"
    class="btn"
    aria-label="Refresh telemetry"
    disabled={loading}
    onclick={onRefresh}
  >
    {loading ? 'Sync…' : 'Sync'}
  </button>
</header>
