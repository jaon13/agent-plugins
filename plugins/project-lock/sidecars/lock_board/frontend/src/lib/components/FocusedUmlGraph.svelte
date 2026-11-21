<script lang="ts">
  import {
    computeUmlDiagramLayout,
    formatUmlEdgeLabel,
    formatUmlMemberLine,
    formatUmlNodeSubline,
    getUmlNodeClass,
  } from '../domain/umlLayoutPure.ts';
  import type { UmlGraphResponse, UmlMode } from '../types/board.ts';
  import UmlSequenceSvg from './UmlSequenceSvg.svelte';

  interface Props {
    graph: UmlGraphResponse | null;
    mode: UmlMode;
    hops: number;
    focus: string;
    loading: boolean;
    onModeChange: (m: UmlMode) => void;
    onHopsChange: (h: number) => void;
    onSelectFocus: (target: string) => void;
    onCopyMermaid: (mermaid: string) => void;
  }

  const UML_MODES: readonly { readonly id: UmlMode; readonly label: string }[] = [
    { id: 'type', label: 'Types' },
    { id: 'module', label: 'Modules' },
    { id: 'sequence', label: 'Sequence' },
    { id: 'state', label: 'State' },
  ];

  let {
    graph,
    mode,
    hops,
    focus,
    loading,
    onModeChange,
    onHopsChange,
    onSelectFocus,
    onCopyMermaid,
  }: Props = $props();

  const layout = $derived(computeUmlDiagramLayout(graph?.nodes ?? [], graph?.edges ?? []));
  const seqSteps = $derived(graph?.sequenceSteps ?? []);
  const terminalList = $derived(graph?.terminalStates ?? []);
</script>

<div class="surface-card uml-card">
  <div class="panel-head uml-controls">
    <div class="uml-left">
      <h3 class="panel-title">Focused UML ({graph?.nodes.length ?? 0} nodes)</h3>
      <div class="segmented" role="group" aria-label="UML granularity">
        {#each UML_MODES as item (item.id)}
          <button
            type="button"
            class={mode === item.id ? 'seg-btn active' : 'seg-btn'}
            onclick={() => { onModeChange(item.id); }}
          >
            {item.label}
          </button>
        {/each}
      </div>
      <div class="segmented" role="group" aria-label="Hop depth">
        <button
          type="button"
          class={hops === 1 ? 'seg-btn active' : 'seg-btn'}
          onclick={() => { onHopsChange(1); }}
        >
          1-hop
        </button>
        <button
          type="button"
          class={hops === 2 ? 'seg-btn active' : 'seg-btn'}
          onclick={() => { onHopsChange(2); }}
        >
          2-hop
        </button>
      </div>
    </div>

    <div class="uml-right">
      {#if (graph?.availableTargets.length ?? 0) > 0}
        <select
          class="uml-select"
          aria-label="Focus symbol or module"
          value={graph?.focus || focus || ''}
          onchange={(e) => { onSelectFocus(e.currentTarget.value); }}
        >
          {#each graph?.availableTargets ?? [] as choice (choice)}
            <option value={choice}>{choice}</option>
          {/each}
        </select>
      {/if}
      <button
        type="button"
        class="btn"
        disabled={!graph?.mermaid}
        onclick={() => { if (graph?.mermaid) onCopyMermaid(graph.mermaid); }}
      >
        Copy Mermaid
      </button>
    </div>
  </div>

  {#if loading}
    <p class="muted">Loading UML graph from .xray/index.db…</p>
  {:else if !graph?.ok || (mode === 'sequence' ? seqSteps.length === 0 : layout.nodes.length === 0)}
    <p class="muted">{graph?.error || 'Select an indexed workspace to preview 1-2 hop relationships.'}</p>
  {:else if mode === 'sequence'}
    <UmlSequenceSvg
      nodes={graph.nodes}
      steps={seqSteps}
      focus={graph.focus || focus}
      {onSelectFocus}
    />
  {:else}
    {#if mode === 'state' && terminalList.length > 0}
      <div class="state-banner">
        <span class="pill pill-warn">Terminal (No Exit): {terminalList.join(', ')}</span>
      </div>
    {/if}
    <div class="svg-scroll">
      <svg
        class="uml-svg"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={`Focused ${mode} UML around ${graph.focus || 'root'}`}
      >
        <defs>
          <marker id="uml-arrow-uses" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 1 L 9 5 L 0 9 z" class="uml-arrow-fill" />
          </marker>
          <marker id="uml-arrow-inherits" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 1 1 L 11 6 L 1 11 z" class="uml-arrow-hollow" />
          </marker>
        </defs>

        {#each layout.edges as le (`${le.edge.from}->${le.edge.to}:${le.edge.relation}:${le.edge.label}`)}
          <path
            d={le.path}
            class={le.dashed ? 'uml-edge dashed' : 'uml-edge'}
            marker-end={le.markerKind === 'uses' ? 'url(#uml-arrow-uses)' : 'url(#uml-arrow-inherits)'}
          />
          <text x={le.labelX} y={le.labelY} class="uml-edge-label" text-anchor="middle">
            <title>{le.edge.label}</title>
            {formatUmlEdgeLabel(le.edge.label)}
          </text>
        {/each}

        {#each layout.nodes as ln (ln.node.id)}
          {@const clickTarget = mode === 'state' && ln.node.id !== '[*]' && ln.node.id !== 'Any (*)' ? ln.node.fullName : ln.node.name}
          <g
            class={getUmlNodeClass(ln.node)}
            transform={`translate(${ln.x}, ${ln.y})`}
            role="button"
            tabindex="0"
            aria-label={`Focus graph on ${ln.node.name}`}
            onclick={() => { onSelectFocus(clickTarget); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectFocus(clickTarget); }}
          >
            <rect width={ln.w} height={ln.h} rx="8" class="uml-box" />
            <text x="10" y="19" class="uml-title">{ln.node.name.slice(0, 21)}</text>
            <text x="10" y="34" class="uml-sub">{formatUmlNodeSubline(ln.node)}</text>
            <line x1="0" y1="42" x2={ln.w} y2="42" class="uml-divider" />
            {#each ln.node.members.slice(0, 2) as m, idx (`${idx}:${m.name}`)}
              <text x="10" y={57 + idx * 14} class="uml-member">
                {formatUmlMemberLine(m.name, m.returnType)}
              </text>
            {/each}
          </g>
        {/each}
      </svg>
    </div>
  {/if}
  {#if graph?.truncated}
    <div class="muted">Showing focused slice cleanly; click any node to re-focus.</div>
  {/if}
</div>

<style>
  .uml-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .uml-controls,
  .uml-left,
  .uml-right {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .uml-select {
    background-color: var(--bg-elevated);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--fs-xs);
    padding: 4px 8px;
    max-width: 190px;
  }

  .svg-scroll {
    overflow: auto;
    border-radius: var(--radius-sm);
    background-color: var(--bg-canvas);
    border: 1px solid var(--border-hairline);
    padding: 6px;
  }

  .uml-svg {
    display: block;
    margin: 0 auto;
  }

  .uml-box {
    fill: var(--bg-surface);
    stroke: var(--border-strong);
    stroke-width: 1;
  }

  .uml-node {
    cursor: pointer;
  }

  .uml-node.focus .uml-box {
    stroke: var(--accent);
    stroke-width: 1.5;
  }

  .uml-node.initial .uml-box {
    stroke: var(--status-doing);
    stroke-width: 1.4;
  }

  .uml-node.terminal .uml-box {
    stroke: var(--status-warn);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
  }

  .state-banner {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .uml-divider {
    stroke: var(--border-hairline);
    stroke-width: 1;
  }

  .uml-title {
    fill: var(--text-primary);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .uml-sub,
  .uml-edge-label,
  .uml-member {
    fill: var(--text-secondary);
    font-size: var(--fs-2xs);
    font-family: var(--font-mono);
  }

  .uml-edge-label {
    paint-order: stroke;
    stroke: var(--bg-canvas);
    stroke-width: 4px;
    stroke-linejoin: round;
  }

  .uml-edge {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.4;
  }

  .uml-edge.dashed {
    stroke-dasharray: 4 3;
    stroke: var(--accent);
  }

  .uml-arrow-fill {
    fill: var(--text-muted);
  }

  .uml-arrow-hollow {
    fill: var(--bg-canvas);
    stroke: var(--accent);
    stroke-width: 1.2;
  }
</style>
