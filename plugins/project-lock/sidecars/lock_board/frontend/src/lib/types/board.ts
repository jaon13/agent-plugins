/** Strict domain contracts matching `/api/state` and `/api/xray/uml`. */

export type TabId = 'board' | 'locks' | 'xray';
export type BoardStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type BoardFilter = 'all' | BoardStatus;
export type LockMode = 'FILE_WRITE' | 'TEST_SHARED' | 'BUILD_EXCL';

export interface LockActivity {
  readonly status: 'active' | 'suspect' | 'stalled' | 'stale';
  readonly activeTaskCount?: number;
  readonly idleSeconds?: number;
}

export interface LockItem {
  readonly moduleKey: string;
  readonly moduleRoot: string;
  readonly isShared: boolean;
  readonly ownerId: string;
  readonly ownerTitle?: string;
  readonly ownerWorkspaceName?: string;
  readonly ownerProjectId?: string;
  readonly workspace: string;
  readonly ownerLockCount?: number;
  readonly maxLocksPerSession?: number;
  readonly tags: readonly string[];
  readonly idleSeconds: number;
  readonly ttlRemainingSeconds: number;
  readonly reservedUntil: number | null;
  readonly isReserved: boolean;
  readonly reservedRemainingSeconds: number | null;
  readonly gitDirty: boolean | null;
  readonly activity?: LockActivity;
}

export interface ClaimItem {
  readonly claimId: string;
  readonly moduleKey: string;
  readonly scopeKey: string;
  readonly fileRelpath: string;
  readonly lockMode: LockMode;
  readonly toolCallId: string;
  readonly ownerId: string;
  readonly ownerTitle?: string;
  readonly ownerWorkspaceName?: string;
  readonly workspace: string;
  readonly tags: readonly string[];
  readonly idleSeconds: number;
  readonly isReserved: boolean;
  readonly reservedRemainingSeconds: number | null;
  readonly ttlRemainingSeconds: number;
}

export interface QueueItem {
  readonly id: number;
  readonly requestGroupId: string;
  readonly moduleKey: string;
  readonly lockMode?: LockMode;
  readonly fileRelpath?: string;
  readonly waiterConvId: string;
  readonly waiterTitle?: string;
  readonly waiterWorkspaceName?: string;
  readonly waiterWorkspace: string;
  readonly sessionKind: string;
  readonly reasonTag: string;
  readonly status: 'waiting' | 'promoted';
  readonly wakeStatus: string;
  readonly position: number;
  readonly reservedRemainingSeconds: number | null;
}

export interface EventItem {
  readonly id: number;
  readonly ts: number;
  readonly event: string;
  readonly moduleKey: string;
  readonly convId: string;
  readonly convTitle?: string;
  readonly detail: string;
}

export interface TodoItem {
  readonly state: 'todo' | 'doing' | 'done';
  readonly text: string;
}

export interface TodoCounts {
  readonly total: number;
  readonly todo: number;
  readonly doing: number;
  readonly done: number;
}

export interface HeldFileRef {
  readonly moduleKey: string;
  readonly lockMode: LockMode;
  readonly fileRelpath: string;
}

export interface BoardTask {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly status: BoardStatus;
  readonly where: string;
  readonly workspaceName: string;
  readonly modules: readonly string[];
  readonly lockModes: readonly string[];
  readonly heldFiles: readonly HeldFileRef[];
  readonly todos: readonly TodoItem[];
  readonly todoCounts: TodoCounts;
  readonly blockedReason: string;
  readonly subagentCount: number;
  readonly subagentRoles: readonly string[];
  readonly activeTaskLogs: number;
  readonly updatedAt: number;
  readonly idleSeconds: number | null;
}

export interface BoardCounts {
  readonly todo: number;
  readonly in_progress: number;
  readonly blocked: number;
  readonly done: number;
}

export interface ToolingBinary {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly summary: string;
  readonly description: string;
  readonly actionHint: string;
  readonly exists: boolean;
  readonly path: string;
}

export interface ByteRagInfo {
  readonly scope: 'workspace' | 'global' | 'missing';
  readonly indexBin: {
    readonly exists: boolean;
    readonly path: string;
    readonly sizeBytes: number;
    readonly mtimeMs: number | null;
    readonly stale: boolean;
  };
  readonly knowledgeDir: {
    readonly exists: boolean;
    readonly path: string;
    readonly docCount: number;
    readonly latestMtimeMs: number | null;
  };
}

export interface XrayWorkspace {
  readonly workspacePath: string;
  readonly name: string;
  readonly source: string;
  readonly indexDb: {
    readonly exists: boolean;
    readonly updatedEpoch?: number | null;
    readonly counts?: {
      readonly projects?: number | null;
      readonly files?: number | null;
      readonly types?: number | null;
      readonly members?: number | null;
      readonly stateTransitions?: number | null;
    };
  };
  readonly reviews: readonly { readonly fileName: string; readonly totalItems: number; readonly kind: string }[];
  readonly byteRag?: ByteRagInfo;
}

export interface LockBoardState {
  readonly now: number;
  readonly autoWakeEnabled: boolean;
  readonly guardSettings: {
    readonly maxLocksPerSession: number;
    readonly maxSharedDepsWithoutNodeps: number;
  };
  readonly locks: readonly LockItem[];
  readonly claims: readonly ClaimItem[];
  readonly lock_queue: readonly QueueItem[];
  readonly lock_events: readonly EventItem[];
  readonly boardTasks: readonly BoardTask[];
  readonly boardCounts: BoardCounts;
  readonly tooling: {
    readonly binaries: readonly ToolingBinary[];
  };
  readonly xray: {
    readonly workspaces: readonly XrayWorkspace[];
  };
}

export type UmlMode = 'type' | 'module' | 'sequence' | 'state';

export interface UmlMember {
  readonly name: string;
  readonly kind: string;
  readonly returnType: string;
}

export interface UmlNode {
  readonly id: string;
  readonly name: string;
  readonly fullName: string;
  readonly kind: string;
  readonly subtitle: string;
  readonly rank: number;
  readonly isFocus: boolean;
  readonly members: readonly UmlMember[];
}

export interface UmlEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly label: string;
}

export interface UmlSequenceStep {
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly message: string;
  readonly isAsync: boolean;
  readonly line: number;
}

export interface UmlGraphResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly workspacePath?: string;
  readonly mode?: UmlMode;
  readonly focus?: string;
  readonly hops?: number;
  readonly availableTargets: readonly string[];
  readonly nodes: readonly UmlNode[];
  readonly edges: readonly UmlEdge[];
  readonly sequenceSteps?: readonly UmlSequenceStep[];
  readonly terminalStates?: readonly string[];
  readonly truncated?: boolean;
  readonly mermaid: string;
}

export interface XrayActionResponse {
  readonly ok: boolean;
  readonly action: 'refresh' | 'check';
  readonly workspacePath: string;
  readonly durationMs: number;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly error?: string;
  readonly state?: LockBoardState;
}
