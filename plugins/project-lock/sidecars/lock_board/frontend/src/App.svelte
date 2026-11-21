<script lang="ts">
  import { onMount } from 'svelte';
  import HeaderBar from './lib/components/HeaderBar.svelte';
  import KanbanBoard from './lib/components/KanbanBoard.svelte';
  import LocksPanel from './lib/components/LocksPanel.svelte';
  import XrayPanel from './lib/components/XrayPanel.svelte';
  import { boardStore } from './lib/state/boardStore.svelte.ts';
  import type { BoardFilter, TabId, UmlMode } from './lib/types/board.ts';

  onMount(() => {
    let cleanup = (): void => {};
    void boardStore.init().then((fn) => {
      cleanup = fn;
    });
    return () => {
      cleanup();
    };
  });

  function handleSelectTab(tab: TabId): void {
    boardStore.activeTab = tab;
    boardStore.pinnedTaskId = null;
    if (tab === 'xray' && !boardStore.umlGraph) {
      void boardStore.loadUml();
    }
  }

  async function handleCopyMermaid(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      boardStore.showToast('Mermaid 다이어그램을 클립보드에 복사했습니다.');
    } catch {
      boardStore.showToast('클립보드 권한이 제한되어 복사에 실패했습니다.', true);
    }
  }
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      boardStore.hoveredTaskId = null;
      boardStore.pinnedTaskId = null;
    }
  }}
/>

<div class="shell">
  <HeaderBar
    activeTab={boardStore.activeTab}
    lockCount={boardStore.state?.locks.length ?? 0}
    claimCount={boardStore.state?.claims.length ?? 0}
    boardCount={boardStore.state?.boardTasks.length ?? 0}
    pollError={boardStore.pollError}
    loading={boardStore.loading}
    onSelectTab={handleSelectTab}
    onRefresh={() => { void boardStore.refresh(); }}
  />

  <main class="main-pane">
    {#if boardStore.activeTab === 'board'}
      <KanbanBoard
        tasks={boardStore.state?.boardTasks ?? []}
        counts={boardStore.state?.boardCounts ?? { todo: 0, in_progress: 0, blocked: 0, done: 0 }}
        filter={boardStore.narrowFilter}
        inspectedId={boardStore.inspectedTaskId}
        pinnedId={boardStore.pinnedTaskId}
        onFilterChange={(f: BoardFilter) => { boardStore.narrowFilter = f; }}
        onHover={(id: string | null) => { boardStore.hoveredTaskId = id; }}
        onDismiss={() => {
          boardStore.hoveredTaskId = null;
          boardStore.pinnedTaskId = null;
        }}
        onTogglePin={(id: string) => {
          boardStore.pinnedTaskId = boardStore.pinnedTaskId === id ? null : id;
        }}
        onOpenSession={(id: string) => { boardStore.openSession(id); }}
        onUnlockModule={(mod: string) => { void boardStore.unlock(mod, false); }}
      />
    {:else if boardStore.activeTab === 'locks'}
      <LocksPanel
        locks={boardStore.state?.locks ?? []}
        claims={boardStore.state?.claims ?? []}
        queue={boardStore.state?.lock_queue ?? []}
        events={boardStore.state?.lock_events ?? []}
        autoWakeEnabled={boardStore.state?.autoWakeEnabled ?? true}
        maxLocksPerSession={boardStore.state?.guardSettings.maxLocksPerSession ?? 8}
        maxSharedDeps={boardStore.state?.guardSettings.maxSharedDepsWithoutNodeps ?? 3}
        busy={boardStore.busy}
        onToggleAutoWake={(en: boolean) => { void boardStore.toggleAutoWake(en); }}
        onUnlockExpired={() => { void boardStore.unlock('', true); }}
        onUnlockModule={(mod: string) => { void boardStore.unlock(mod, false); }}
        onWakeNow={(id: number) => { void boardStore.wakeNow(id); }}
        onCancelQueue={(id: number) => { void boardStore.cancelQueue(id); }}
        onOpenSession={(id: string) => { boardStore.openSession(id); }}
      />
    {:else}
      <XrayPanel
        workspaces={boardStore.state?.xray.workspaces ?? []}
        binaries={boardStore.state?.tooling.binaries ?? []}
        selectedToolIds={boardStore.selectedToolIds}
        umlGraph={boardStore.umlGraph}
        umlMode={boardStore.umlMode}
        umlHops={boardStore.umlHops}
        umlFocus={boardStore.umlFocus}
        umlWorkspace={boardStore.umlWorkspace}
        umlLoading={boardStore.umlLoading}
        actionOutput={boardStore.actionOutput}
        busy={boardStore.busy}
        onWorkspaceChange={(ws: string) => {
          boardStore.umlWorkspace = ws;
          boardStore.umlFocus = '';
          void boardStore.loadUml('');
        }}
        onRefreshIndex={(ws: string) => { void boardStore.runRefreshIndex(ws); }}
        onCheckConsistency={(ws: string) => { void boardStore.runConsistencyCheck(ws); }}
        onToggleTool={(id: string) => { boardStore.toggleTool(id); }}
        onClearTools={() => { boardStore.clearTools(); }}
        onExecuteTools={() => { void boardStore.executeSelectedTools(); }}
        onUmlModeChange={(m: UmlMode) => {
          boardStore.umlMode = m;
          boardStore.umlFocus = '';
          void boardStore.loadUml('');
        }}
        onUmlHopsChange={(h: number) => {
          boardStore.umlHops = h;
          void boardStore.loadUml();
        }}
        onUmlFocus={(target: string) => { void boardStore.loadUml(target); }}
        onCopyMermaid={handleCopyMermaid}
      />
    {/if}
  </main>

  {#if boardStore.toast}
    <div class={boardStore.toast.isError ? 'toast-bar error' : 'toast-bar'} role="status">
      {boardStore.toast.text}
    </div>
  {/if}
</div>
