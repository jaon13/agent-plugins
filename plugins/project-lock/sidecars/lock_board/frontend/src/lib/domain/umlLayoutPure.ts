import type { UmlEdge, UmlNode } from '../types/board.ts';

export interface LayoutNode {
  readonly node: UmlNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface LayoutEdge {
  readonly edge: UmlEdge;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly dashed: boolean;
  readonly markerKind: 'inherits' | 'implements' | 'uses';
}

export interface UmlDiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
}

const CARD_W = 178;
const CARD_H = 84;
const COL_GAP = 116;
const ROW_GAP = 22;
const PAD = 22;

const KIND_LABEL_MAP: Readonly<Record<string, string>> = {
  'terminal-state': 'terminal',
  'initial-state': 'init',
  'wildcard-state': 'any',
  'init-marker': 'start',
};

export function formatUmlNodeSubline(node: UmlNode): string {
  const shortKind = KIND_LABEL_MAP[node.kind] ?? node.kind;
  const combined = node.subtitle ? `${shortKind} · ${node.subtitle}` : shortKind;
  return combined.slice(0, 23);
}

export function formatUmlEdgeLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

export function formatUmlMemberLine(name: string, returnType: string): string {
  const full = returnType ? `+${name}: ${returnType}` : `+${name}`;
  return full.slice(0, 23);
}

export function getUmlNodeClass(node: UmlNode): string {
  if (node.kind === 'terminal-state') return 'uml-node terminal';
  if (node.kind === 'initial-state') return 'uml-node initial';
  return node.isFocus ? 'uml-node focus' : 'uml-node';
}

export function computeUmlDiagramLayout(
  nodes: ReadonlyArray<UmlNode>,
  edges: ReadonlyArray<UmlEdge>
): UmlDiagramLayout {
  if (nodes.length === 0) {
    return { width: 320, height: 140, nodes: [], edges: [] };
  }

  const ranks = Array.from(new Set(nodes.map((n) => n.rank))).sort((a, b) => a - b);
  const rankToCol = new Map(ranks.map((r, i) => [r, i]));
  const columns = ranks.map((r) => nodes.filter((n) => n.rank === r));
  const maxRows = columns.reduce((acc, col) => Math.max(acc, col.length), 1);

  const height = Math.max(216, PAD * 2 + maxRows * CARD_H + (maxRows - 1) * ROW_GAP + 54);
  const width = Math.max(380, PAD * 2 + columns.length * CARD_W + (columns.length - 1) * COL_GAP);

  const layoutNodes: readonly LayoutNode[] = columns.flatMap((col, colIdx) => {
    const colHeight = col.length * CARD_H + Math.max(0, col.length - 1) * ROW_GAP;
    const topOffset = Math.max(0, (height - PAD * 2 - 44 - colHeight) / 2);
    const x = PAD + colIdx * (CARD_W + COL_GAP);
    return col.map((node, rowIdx) => ({
      node,
      x,
      y: Math.round(PAD + topOffset + rowIdx * (CARD_H + ROW_GAP)),
      w: CARD_W,
      h: CARD_H,
    }));
  });

  const byId = new Map(layoutNodes.map((ln) => [ln.node.id, ln]));
  const directedPairs = new Set(edges.map((e) => `${e.from}|${e.to}`));
  const layoutEdges: readonly LayoutEdge[] = edges
    .map((edge, idx): LayoutEdge | null => {
      const src = byId.get(edge.from);
      const dst = byId.get(edge.to);
      if (!src || !dst) return null;

      const srcCol = rankToCol.get(src.node.rank) ?? 0;
      const dstCol = rankToCol.get(dst.node.rank) ?? 0;
      const sameCol = srcCol === dstCol;
      const skipCols = Math.abs(dstCol - srcCol) > 1;
      const goRight = dst.x > src.x;
      const isBidirectional = !sameCol && !skipCols && directedPairs.has(`${edge.to}|${edge.from}`);
      const laneOffset = isBidirectional ? (edge.from < edge.to ? -15 : 15) : 0;

      const x1 = skipCols
        ? Math.round(src.x + src.w / 2)
        : sameCol
          ? src.x + src.w
          : goRight
            ? src.x + src.w
            : src.x;
      const y1 = skipCols ? src.y + src.h : Math.round(src.y + src.h / 2) + laneOffset;
      const x2 = skipCols
        ? Math.round(dst.x + dst.w / 2)
        : sameCol
          ? dst.x + dst.w
          : goRight
            ? dst.x
            : dst.x + dst.w;
      const y2 = skipCols ? dst.y + dst.h : Math.round(dst.y + dst.h / 2) + laneOffset;

      const bendY = Math.min(height - 16, Math.max(y1, y2) + 34 + (idx % 2) * 14);
      const dx = sameCol ? 32 : Math.max(28, Math.abs(x2 - x1) * 0.45);
      const cx1 = skipCols ? x1 : sameCol ? x1 + dx : goRight ? x1 + dx : x1 - dx;
      const cx2 = skipCols ? x2 : sameCol ? x2 + dx : goRight ? x2 - dx : x2 + dx;
      const cy1 = skipCols ? bendY : y1 + laneOffset * 1.1;
      const cy2 = skipCols ? bendY : y2 + laneOffset * 1.1;

      const markerKind =
        edge.relation === 'inherits'
          ? 'inherits'
          : edge.relation === 'implements'
            ? 'implements'
            : 'uses';

      const defaultLabelY = Math.round((y1 + y2) / 2) + (laneOffset > 0 ? 15 : -8);
      return {
        edge,
        path: `M ${x1} ${y1} C ${Math.round(cx1)} ${Math.round(cy1)}, ${Math.round(cx2)} ${Math.round(cy2)}, ${x2} ${y2}`,
        labelX: Math.round((x1 + x2) / 2),
        labelY: skipCols ? Math.round((cy1 + cy2) / 2) - 4 : defaultLabelY,
        dashed: markerKind === 'implements',
        markerKind,
      };
    })
    .filter((item): item is LayoutEdge => item !== null);

  return { width, height, nodes: layoutNodes, edges: layoutEdges };
}
