import type { BoardStatus, BoardTask, ToolingBinary } from '../types/board.ts';

export type ColumnBuckets = {
  readonly todo: readonly BoardTask[];
  readonly in_progress: readonly BoardTask[];
  readonly blocked: readonly BoardTask[];
  readonly done: readonly BoardTask[];
};

export function groupTasksByColumn(tasks: ReadonlyArray<BoardTask>): ColumnBuckets {
  const by = (status: BoardStatus): readonly BoardTask[] =>
    tasks.filter((t) => t.status === status);
  return {
    todo: by('todo'),
    in_progress: by('in_progress'),
    blocked: by('blocked'),
    done: by('done'),
  };
}

export function formatAgeSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function shortConvId(convId: string): string {
  return convId.slice(0, 8);
}

const EVENT_BADGE_MAP: Readonly<Record<string, string>> = {
  ACQUIRED: 'pill pill-doing',
  CLAIMED: 'pill pill-doing',
  WAKE_SENT: 'pill pill-doing',
  RELEASE: 'pill pill-done',
  RELEASE_BARRIER: 'pill pill-done',
  QUEUED: 'pill pill-queue',
  PROMOTED: 'pill pill-queue',
  WAKE_DEFERRED: 'pill pill-queue',
  TTL_EXPIRED: 'pill pill-warn',
  RESERVATION_EXPIRED: 'pill pill-warn',
  MANUAL_UNLOCK: 'pill pill-warn',
  MANUAL_UNLOCK_ALL: 'pill pill-warn',
  QUEUE_CANCELLED: 'pill pill-warn',
  DEADLOCK_RISK: 'pill pill-blocked',
  LIMIT_DENIED: 'pill pill-blocked',
  DEP_GUARD_DENIED: 'pill pill-blocked',
  WAKE_FAILED: 'pill pill-blocked',
  AUTO_WAKE_TOGGLED: 'pill',
  MIGRATED: 'pill',
};

export function eventBadgeClass(eventName: string): string {
  const key = eventName.trim().toUpperCase();
  const mapped = EVENT_BADGE_MAP[key];
  if (mapped) return mapped;
  if (key.includes('DENIED') || key.includes('FAILED') || key.includes('ERROR')) {
    return 'pill pill-blocked';
  }
  if (key.includes('EXPIRED') || key.includes('UNLOCK') || key.includes('CANCEL')) {
    return 'pill pill-warn';
  }
  if (key.includes('QUEUE') || key.includes('PROMOT') || key.includes('DEFER')) {
    return 'pill pill-queue';
  }
  if (key.includes('RELEASE')) return 'pill pill-done';
  if (key.includes('ACQUIR') || key.includes('CLAIM') || key.startsWith('WAKE_')) {
    return 'pill pill-doing';
  }
  return 'pill';
}

const TOOL_TASK_STEPS: Readonly<Record<string, string>> = {
  'code-xray': 'Run code-xray MCP analysis.',
  'uia-mcp': 'Inspect active UI tree with rpa-mcp.',
  'xray-index': 'Rebuild workspace .xray/index.db index.',
  'xray-grep': 'Search code symbols and references via xray-grep.',
  'structural-clone': 'Run structural-clone scan.',
  opengrep: 'Run opengrep SAST scan.',
};

export function buildToolingPrompt(
  selectedIds: ReadonlyArray<string>,
  binaries: ReadonlyArray<ToolingBinary>,
  workspacePaths: ReadonlyArray<string>
): string {
  const byId = new Map(binaries.map((b) => [b.id, b]));
  const chosen = selectedIds
    .map((id) => byId.get(id))
    .filter((b): b is ToolingBinary => b !== undefined);
  if (chosen.length === 0) return '';

  const wsLine = workspacePaths.length > 0 ? workspacePaths.join(', ') : '(active workspace)';
  const toolList = chosen.map((b) => `- ${b.label} (${b.id}): ${TOOL_TASK_STEPS[b.id] ?? b.actionHint}`);
  return [
    `Workspace: ${wsLine}`,
    'Selected tooling tasks:',
    ...toolList,
  ].join('\n');
}
