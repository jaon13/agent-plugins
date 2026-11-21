import type { UmlNode, UmlSequenceStep } from '../types/board.ts';

export interface SequenceLifeline {
  readonly node: UmlNode;
  readonly centerX: number;
  readonly headerX: number;
  readonly headerY: number;
  readonly headerW: number;
  readonly headerH: number;
  readonly lineTopY: number;
  readonly lineBottomY: number;
}

export interface SequenceMessageLayout {
  readonly step: UmlSequenceStep;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly textAnchor: 'start' | 'middle';
  readonly displayText: string;
  readonly isSelf: boolean;
}

export interface SequenceDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly lifelines: readonly SequenceLifeline[];
  readonly messages: readonly SequenceMessageLayout[];
}

const HEADER_W = 132;
const HEADER_H = 42;
const COL_STEP = 160;
const ROW_STEP = 40;
const PAD_X = 24;
const PAD_Y = 18;

export function computeSequenceDiagramLayout(
  nodes: ReadonlyArray<UmlNode>,
  steps: ReadonlyArray<UmlSequenceStep>
): SequenceDiagramLayout {
  if (nodes.length === 0) {
    return { width: 320, height: 140, lifelines: [], messages: [] };
  }

  const topY = PAD_Y + HEADER_H;
  const lineBottomY = topY + Math.max(1, steps.length) * ROW_STEP + 24;
  const height = lineBottomY + 24;
  const width = Math.max(380, PAD_X * 2 + (nodes.length - 1) * COL_STEP + HEADER_W);

  const lifelines: readonly SequenceLifeline[] = nodes.map((node, idx) => {
    const headerX = PAD_X + idx * COL_STEP;
    const centerX = Math.round(headerX + HEADER_W / 2);
    return {
      node,
      centerX,
      headerX,
      headerY: PAD_Y,
      headerW: HEADER_W,
      headerH: HEADER_H,
      lineTopY: topY,
      lineBottomY,
    };
  });

  const centerById = new Map(lifelines.map((l) => [l.node.id, l.centerX]));

  const messages: readonly SequenceMessageLayout[] = steps
    .map((step, idx): SequenceMessageLayout | null => {
      const x1 = centerById.get(step.from);
      const x2 = centerById.get(step.to);
      if (x1 === undefined || x2 === undefined) return null;

      const y = topY + 26 + idx * ROW_STEP;
      const isSelf = step.from === step.to;
      const rawText =
        step.trigger && step.trigger !== '<init>'
          ? `${step.seq}. ${step.trigger}: ${step.message}`
          : `${step.seq}. ${step.message}`;
      const displayText = rawText.slice(0, 32);

      if (isSelf) {
        return {
          step,
          path: `M ${x1} ${y - 8} C ${x1 + 46} ${y - 8}, ${x1 + 46} ${y + 12}, ${x1} ${y + 12}`,
          labelX: x1 + 48,
          labelY: y + 4,
          textAnchor: 'start',
          displayText,
          isSelf: true,
        };
      }

      const goRight = x2 > x1;
      const targetX = goRight ? x2 - 4 : x2 + 4;
      return {
        step,
        path: `M ${x1} ${y} L ${targetX} ${y}`,
        labelX: Math.round((x1 + targetX) / 2),
        labelY: y - 7,
        textAnchor: 'middle',
        displayText,
        isSelf: false,
      };
    })
    .filter((item): item is SequenceMessageLayout => item !== null);

  return { width, height, lifelines, messages };
}
