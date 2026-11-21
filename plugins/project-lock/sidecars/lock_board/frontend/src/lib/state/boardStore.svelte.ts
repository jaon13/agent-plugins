import {
  fetchState,
  fetchXrayUml,
  getActiveWorkspaces,
  postAutoWake,
  postQueueCancel,
  postUnlock,
  postWake,
  postXrayCheck,
  postXrayRefresh,
  sendAgentMessage,
  subscribeWorkspaces,
  toggleConversation,
} from '../api/sidecarClient.ts';
import { buildToolingPrompt } from '../domain/boardPure.ts';
import type {
  BoardFilter,
  LockBoardState,
  TabId,
  UmlGraphResponse,
  UmlMode,
  XrayActionResponse,
} from '../types/board.ts';

const POLL_INTERVAL_MS = 2000;

export class BoardStore {
  state = $state<LockBoardState | null>(null);
  activeWorkspaces = $state<readonly string[]>([]);
  activeTab = $state<TabId>('board');
  narrowFilter = $state<BoardFilter>('all');
  hoveredTaskId = $state<string | null>(null);
  pinnedTaskId = $state<string | null>(null);
  loading = $state<boolean>(false);
  busy = $state<boolean>(false);
  pollError = $state<string>('');
  toast = $state<{ readonly text: string; readonly isError: boolean } | null>(null);
  selectedToolIds = $state<readonly string[]>([]);

  umlGraph = $state<UmlGraphResponse | null>(null);
  umlMode = $state<UmlMode>('type');
  umlHops = $state<number>(1);
  umlFocus = $state<string>('');
  umlWorkspace = $state<string>('');
  umlLoading = $state<boolean>(false);
  actionOutput = $state<XrayActionResponse | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;
  #unsubWs: (() => void) | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = false;
  #refreshPending = false;

  showToast(text: string, isError = false): void {
    this.toast = { text, isError };
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => {
      this.toast = null;
    }, 3400);
  }

  get inspectedTaskId(): string | null {
    return this.pinnedTaskId ?? this.hoveredTaskId;
  }

  async #resolveInitialWorkspaces(): Promise<void> {
    const initial = await Promise.race([
      getActiveWorkspaces(),
      new Promise<readonly string[]>((resolve) => {
        setTimeout(() => {
          resolve([]);
        }, 600);
      }),
    ]);
    if (initial.length > 0 && this.activeWorkspaces.length === 0) {
      this.activeWorkspaces = initial;
      void this.refresh();
    }
  }

  async init(): Promise<() => void> {
    this.#unsubWs = subscribeWorkspaces((nextWs) => {
      this.activeWorkspaces = nextWs;
      void this.refresh();
    });

    const tick = (): void => {
      if (!document.hidden && !this.busy && !this.#inFlight) void this.refresh();
    };
    this.#timer = setInterval(tick, POLL_INTERVAL_MS);
    const onVis = (): void => {
      if (!document.hidden) void this.refresh();
    };
    document.addEventListener('visibilitychange', onVis);

    void this.#resolveInitialWorkspaces();
    await this.refresh();

    return () => {
      if (this.#timer) clearInterval(this.#timer);
      if (this.#toastTimer) clearTimeout(this.#toastTimer);
      if (this.#unsubWs) this.#unsubWs();
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  async refresh(): Promise<void> {
    if (this.#inFlight) {
      this.#refreshPending = true;
      return;
    }
    this.#inFlight = true;
    this.loading = true;
    try {
      const next = await fetchState(this.activeWorkspaces);
      this.state = next;
      this.pollError = '';
      const prevUmlWs = this.umlWorkspace;
      const stillValid = next.xray.workspaces.some((w) => w.workspacePath === this.umlWorkspace);
      if ((!this.umlWorkspace || !stillValid) && next.xray.workspaces.length > 0) {
        const preferred =
          next.xray.workspaces.find((w) => w.indexDb.exists) ?? next.xray.workspaces[0];
        this.umlWorkspace = preferred.workspacePath;
      } else if (next.xray.workspaces.length === 0) {
        this.umlWorkspace = '';
      }
      if (this.umlWorkspace !== prevUmlWs) {
        this.umlGraph = null;
        this.umlFocus = '';
      }
      if (this.activeTab === 'xray' && !this.umlGraph && this.umlWorkspace) {
        void this.loadUml();
      }
    } catch (err) {
      this.pollError = err instanceof Error ? err.message : String(err);
    } finally {
      this.#inFlight = false;
      this.loading = false;
      if (this.#refreshPending) {
        this.#refreshPending = false;
        void this.refresh();
      }
    }
  }

  async unlock(moduleKey: string, expiredOnly = false): Promise<void> {
    this.busy = true;
    try {
      const res = await postUnlock(moduleKey, expiredOnly, this.activeWorkspaces);
      if (res.state) this.state = res.state;
      this.showToast(expiredOnly ? '만료된 락을 정리했습니다.' : `해제 완료: ${moduleKey}`);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  async cancelQueue(id: number): Promise<void> {
    this.busy = true;
    try {
      const res = await postQueueCancel(id, this.activeWorkspaces);
      if (res.state) this.state = res.state;
      this.showToast(`대기 #${id} 취소 완료`);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  async toggleAutoWake(enabled: boolean): Promise<void> {
    this.busy = true;
    try {
      const res = await postAutoWake(enabled, this.activeWorkspaces);
      if (res.state) this.state = res.state;
      this.showToast(enabled ? 'Auto-Wake 활성화' : 'Auto-Wake 비활성화');
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  async wakeNow(id: number): Promise<void> {
    this.busy = true;
    try {
      const res = await postWake(id, this.activeWorkspaces);
      if (res.state) this.state = res.state;
      if (res.sent) this.showToast('승계 세션 깨우기 전송 완료');
      else this.showToast(res.error || '깨우기 전송 실패', true);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  openSession(convId: string): void {
    if (!toggleConversation(convId)) {
      this.showToast(`Session: ${convId.slice(0, 8)} (standalone mode)`);
    }
  }

  toggleTool(id: string): void {
    if (this.selectedToolIds.includes(id)) {
      this.selectedToolIds = this.selectedToolIds.filter((x) => x !== id);
    } else {
      this.selectedToolIds = [...this.selectedToolIds, id];
    }
  }

  clearTools(): void {
    this.selectedToolIds = [];
  }

  async executeSelectedTools(): Promise<void> {
    const bins = this.state?.tooling.binaries ?? [];
    const prompt = buildToolingPrompt(this.selectedToolIds, bins, this.activeWorkspaces);
    if (!prompt) return;
    this.busy = true;
    try {
      const sent = await sendAgentMessage(prompt);
      if (sent) {
        this.selectedToolIds = [];
        this.showToast('Antigravity 채팅으로 분석 요청을 전달했습니다.');
      } else {
        await navigator.clipboard.writeText(prompt);
        this.showToast('브라우저 모드: 클립보드에 분석 프롬프트를 복사했습니다.');
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  async loadUml(focusOverride?: string): Promise<void> {
    const ws = this.umlWorkspace || this.state?.xray.workspaces[0]?.workspacePath || '';
    if (!ws) return;
    if (focusOverride !== undefined) this.umlFocus = focusOverride;
    this.umlLoading = true;
    try {
      this.umlGraph = await fetchXrayUml(ws, this.umlMode, this.umlFocus, this.umlHops);
      if (this.umlGraph.focus) this.umlFocus = this.umlGraph.focus;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.umlLoading = false;
    }
  }

  async runRefreshIndex(workspace: string): Promise<void> {
    this.busy = true;
    try {
      const res = await postXrayRefresh(workspace, this.activeWorkspaces);
      this.actionOutput = res;
      if (res.state) this.state = res.state;
      this.showToast(res.ok ? `Index 갱신 완료 (${res.durationMs}ms)` : res.error || 'Index 갱신 실패', !res.ok);
      if (res.ok) void this.loadUml();
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }

  async runConsistencyCheck(workspace: string): Promise<void> {
    this.busy = true;
    try {
      const res = await postXrayCheck(workspace, this.activeWorkspaces);
      this.actionOutput = res;
      this.showToast(res.ok ? `Consistency PASS (${res.durationMs}ms)` : 'Consistency 검사에서 이슈가 발견되었습니다', !res.ok);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
    }
  }
}

export const boardStore = new BoardStore();
