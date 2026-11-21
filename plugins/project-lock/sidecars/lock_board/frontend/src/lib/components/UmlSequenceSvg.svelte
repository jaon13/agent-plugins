<script lang="ts">
  import { computeSequenceDiagramLayout } from '../domain/umlSequenceLayoutPure.ts';
  import type { UmlNode, UmlSequenceStep } from '../types/board.ts';

  interface Props {
    nodes: readonly UmlNode[];
    steps: readonly UmlSequenceStep[];
    focus: string;
    onSelectFocus: (target: string) => void;
  }

  let { nodes, steps, focus, onSelectFocus }: Props = $props();

  const layout = $derived(computeSequenceDiagramLayout(nodes, steps));
</script>

<div class="seq-wrap">
  <svg
    class="seq-svg"
    width={layout.width}
    height={layout.height}
    viewBox={`0 0 ${layout.width} ${layout.height}`}
    role="group"
    aria-label={`Sequence diagram around ${focus || 'root'}`}
  >
    <defs>
      <marker id="seq-arrow-sync" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 9 5 L 0 9 z" class="seq-arrow-fill" />
      </marker>
      <marker id="seq-arrow-async" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M 1 1 L 9 5 L 1 9" class="seq-arrow-open" />
      </marker>
    </defs>

    {#each layout.lifelines as line (line.node.id)}
      <line
        x1={line.centerX}
        y1={line.lineTopY}
        x2={line.centerX}
        y2={line.lineBottomY}
        class="seq-lifeline"
      />
      <g
        class={line.node.isFocus ? 'seq-actor focus' : 'seq-actor'}
        transform={`translate(${line.headerX}, ${line.headerY})`}
        role="button"
        tabindex="0"
        aria-label={`Focus sequence on ${line.node.name}`}
        onclick={() => { onSelectFocus(line.node.name); }}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectFocus(line.node.name); }}
      >
        <rect width={line.headerW} height={line.headerH} rx="6" class="seq-box" />
        <text x={line.headerW / 2} y="18" class="seq-title" text-anchor="middle">
          {line.node.name.slice(0, 16)}
        </text>
        <text x={line.headerW / 2} y="33" class="seq-sub" text-anchor="middle">
          {line.node.subtitle.slice(0, 15)}
        </text>
      </g>
    {/each}

    {#each layout.messages as msg (`${msg.step.seq}:${msg.step.from}:${msg.step.to}`)}
      <path
        d={msg.path}
        class={msg.step.isAsync ? 'seq-msg async' : 'seq-msg'}
        marker-end={msg.step.isAsync ? 'url(#seq-arrow-async)' : 'url(#seq-arrow-sync)'}
      />
      <text x={msg.labelX} y={msg.labelY} class="seq-label" text-anchor={msg.textAnchor}>
        {msg.displayText}
      </text>
    {/each}
  </svg>
</div>

<style>
  .seq-wrap {
    overflow: auto;
    border-radius: var(--radius-sm);
    background-color: var(--bg-canvas);
    border: 1px solid var(--border-hairline);
    padding: 6px;
  }

  .seq-svg {
    display: block;
    margin: 0 auto;
  }

  .seq-lifeline {
    stroke: var(--border-strong);
    stroke-width: 1.2;
    stroke-dasharray: 4 4;
  }

  .seq-actor {
    cursor: pointer;
  }

  .seq-box {
    fill: var(--bg-surface);
    stroke: var(--border-strong);
    stroke-width: 1;
  }

  .seq-actor.focus .seq-box {
    stroke: var(--accent);
    stroke-width: 1.5;
  }

  .seq-title {
    fill: var(--text-primary);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .seq-sub,
  .seq-label {
    fill: var(--text-secondary);
    font-size: var(--fs-2xs);
    font-family: var(--font-mono);
  }

  .seq-label {
    paint-order: stroke;
    stroke: var(--bg-canvas);
    stroke-width: 4px;
    stroke-linejoin: round;
  }

  .seq-msg {
    fill: none;
    stroke: var(--text-secondary);
    stroke-width: 1.4;
  }

  .seq-msg.async {
    stroke: var(--accent);
    stroke-dasharray: 5 3;
  }

  .seq-arrow-fill {
    fill: var(--text-secondary);
  }

  .seq-arrow-open {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.4;
  }
</style>
