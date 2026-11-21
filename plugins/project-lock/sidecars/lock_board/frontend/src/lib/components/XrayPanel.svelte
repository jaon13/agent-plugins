<script lang="ts">
  import { formatBytes } from '../domain/boardPure.ts';
  import type { ToolingBinary, UmlGraphResponse, UmlMode, XrayActionResponse, XrayWorkspace } from '../types/board.ts';
  import FocusedUmlGraph from './FocusedUmlGraph.svelte';

  interface Props {
    workspaces: readonly XrayWorkspace[];
    binaries: readonly ToolingBinary[];
    selectedToolIds: readonly string[];
    umlGraph: UmlGraphResponse | null;
    umlMode: UmlMode;
    umlHops: number;
    umlFocus: string;
    umlWorkspace: string;
    umlLoading: boolean;
    actionOutput: XrayActionResponse | null;
    busy: boolean;
    onWorkspaceChange: (ws: string) => void;
    onRefreshIndex: (ws: string) => void;
    onCheckConsistency: (ws: string) => void;
    onToggleTool: (id: string) => void;
    onClearTools: () => void;
    onExecuteTools: () => void;
    onUmlModeChange: (m: UmlMode) => void;
    onUmlHopsChange: (h: number) => void;
    onUmlFocus: (target: string) => void;
    onCopyMermaid: (mermaid: string) => void;
  }

  let {
    workspaces,
    binaries,
    selectedToolIds,
    umlGraph,
    umlMode,
    umlHops,
    umlFocus,
    umlWorkspace,
    umlLoading,
    actionOutput,
    busy,
    onWorkspaceChange,
    onRefreshIndex,
    onCheckConsistency,
    onToggleTool,
    onClearTools,
    onExecuteTools,
    onUmlModeChange,
    onUmlHopsChange,
    onUmlFocus,
    onCopyMermaid,
  }: Props = $props();

  const currentWs: XrayWorkspace | null = $derived(
    workspaces.find((w) => w.workspacePath === umlWorkspace) ??
      (workspaces.length > 0 ? workspaces[0] : null)
  );
</script>

<section class="xray-wrap" aria-label="X-Ray, ByteRAG and Tooling hub">
  <div class="surface-card ws-toolbar">
    <div class="ws-select-row">
      <span class="panel-title">Workspace</span>
      {#if currentWs}
        <select
          class="ws-select"
          aria-label="Target workspace"
          value={currentWs.workspacePath}
          onchange={(e) => { onWorkspaceChange(e.currentTarget.value); }}
        >
          {#each workspaces as ws (ws.workspacePath)}
            <option value={ws.workspacePath}>{`${ws.name} (${ws.source})`}</option>
          {/each}
        </select>
      {:else}
        <span class="muted">No active workspace detected</span>
      {/if}
    </div>

    <div class="ws-actions">
      <button
        type="button"
        class="btn btn-accent"
        disabled={busy || !currentWs}
        onclick={() => { if (currentWs) onRefreshIndex(currentWs.workspacePath); }}
      >
        Refresh Index
      </button>
      <button
        type="button"
        class="btn"
        disabled={busy || !currentWs}
        onclick={() => { if (currentWs) onCheckConsistency(currentWs.workspacePath); }}
      >
        Consistency Check
      </button>
    </div>
  </div>

  {#if currentWs}
    <div class="two-col">
      <div class="surface-card">
        <div class="panel-head">
          <h3 class="panel-title">CodeXray Index (.xray/index.db)</h3>
          <span class={currentWs.indexDb.exists ? 'pill pill-doing' : 'pill'}>
            {currentWs.indexDb.exists ? 'Ready' : 'Missing'}
          </span>
        </div>
        <div class="metrics-row">
          <span class="pill">Projects: {currentWs.indexDb.counts?.projects ?? '—'}</span>
          <span class="pill">Files: {currentWs.indexDb.counts?.files ?? '—'}</span>
          <span class="pill">Types: {currentWs.indexDb.counts?.types ?? '—'}</span>
          <span class="pill">Members: {currentWs.indexDb.counts?.members ?? '—'}</span>
          <span class="pill">States: {currentWs.indexDb.counts?.stateTransitions ?? '—'}</span>
          <span class="pill">Reviews: {currentWs.reviews.length}</span>
        </div>
      </div>

      <div class="surface-card">
        <div class="panel-head">
          <h3 class="panel-title">ByteRAG Workspace Cache</h3>
          <span class={currentWs.byteRag?.indexBin.exists ? (currentWs.byteRag.indexBin.stale ? 'pill pill-warn' : 'pill pill-doing') : 'pill'}>
            {currentWs.byteRag?.scope || 'missing'}
          </span>
        </div>
        <div class="metrics-row">
          <span class="pill">
            Index: {currentWs.byteRag?.indexBin.exists ? formatBytes(currentWs.byteRag.indexBin.sizeBytes) : 'Absent'}
          </span>
          <span class="pill">
            Knowledge docs: {currentWs.byteRag?.knowledgeDir.docCount ?? 0}
          </span>
          {#if currentWs.byteRag?.indexBin.stale}
            <span class="pill pill-warn">Stale vs index.db</span>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if actionOutput}
    <div class="surface-card">
      <div class="panel-head">
        <h3 class="panel-title">
          Safe Action: {actionOutput.action} ({actionOutput.durationMs}ms)
        </h3>
        <span class={actionOutput.ok ? 'pill pill-doing' : 'pill pill-blocked'}>
          {actionOutput.ok ? 'PASS' : 'FAILED'}
        </span>
      </div>
      <pre class="action-pre mono">{actionOutput.stdoutPreview || actionOutput.stderrPreview || actionOutput.error || 'Done'}</pre>
    </div>
  {/if}

  <FocusedUmlGraph
    graph={umlGraph}
    mode={umlMode}
    hops={umlHops}
    focus={umlFocus}
    loading={umlLoading}
    onModeChange={onUmlModeChange}
    onHopsChange={onUmlHopsChange}
    onSelectFocus={onUmlFocus}
    {onCopyMermaid}
  />

  <div class="surface-card">
    <div class="panel-head">
      <h3 class="panel-title">Antigravity Chat Dispatch</h3>
      <div class="ws-actions">
        <button type="button" class="btn" disabled={selectedToolIds.length === 0} onclick={onClearTools}>
          Clear
        </button>
        <button type="button" class="btn btn-accent" disabled={selectedToolIds.length === 0} onclick={onExecuteTools}>
          Execute ({selectedToolIds.length})
        </button>
      </div>
    </div>

    <div class="tooling-grid">
      {#each binaries as bin (bin.id)}
        {@const checked = selectedToolIds.includes(bin.id)}
        <label class={checked ? 'binary-card selected' : 'binary-card'}>
          <input
            type="checkbox"
            class="binary-checkbox"
            {checked}
            onchange={() => { onToggleTool(bin.id); }}
          />
          <span class="bin-meta">
            <span class="bin-title">{bin.label}</span>
            <span class="muted bin-summary">{bin.summary}</span>
          </span>
          <span class={bin.exists ? 'pill pill-doing bin-status' : 'pill bin-status'}>
            {bin.exists ? 'Ready' : 'Off'}
          </span>
        </label>
      {/each}
    </div>
  </div>
</section>

<style>
  .xray-wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ws-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .ws-select-row,
  .ws-actions,
  .metrics-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .ws-select {
    background-color: var(--bg-elevated);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--fs-xs);
    padding: 4px 8px;
  }

  .action-pre {
    margin: 0;
    padding: 8px;
    border-radius: var(--radius-sm);
    background-color: var(--bg-canvas);
    color: var(--text-secondary);
    overflow-x: auto;
    max-height: 150px;
    white-space: pre-wrap;
  }

  .tooling-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
    gap: 8px;
  }

  .binary-card {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-sm);
    background-color: var(--bg-subtle);
    cursor: pointer;
  }

  .binary-card.selected {
    border-color: var(--accent);
    background-color: var(--accent-soft);
  }

  .binary-checkbox {
    flex-shrink: 0;
  }

  .bin-meta {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .bin-summary {
    overflow-wrap: anywhere;
  }

  .bin-status {
    flex-shrink: 0;
  }

  .bin-title {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-primary);
  }
</style>
