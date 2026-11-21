import type { LockBoardState, UmlGraphResponse, UmlMode, XrayActionResponse } from '../types/board.ts';

interface SidecarBridge {
  fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  getWorkspaceUris?: () => Promise<readonly string[]>;
  onWorkspaceChange?: (cb: (uris: readonly string[]) => void) => () => void;
  agent?: { sendMessage?: (message: string) => Promise<unknown> };
  ui?: { toggleConversation?: (convId: string) => void };
}

function getBridge(): SidecarBridge | undefined {
  return (window as unknown as { readonly sidecar?: SidecarBridge }).sidecar;
}

function normalizeUriToPath(raw: string): string {
  if (!raw.toLowerCase().startsWith('file://')) return raw;
  try {
    const parsed = new URL(raw);
    const decoded = decodeURIComponent(parsed.pathname);
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return raw;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const bridge = getBridge();
  const res = bridge?.fetch
    ? await bridge.fetch(url, init)
    : await fetch(url, init);
  const rawText = await res.text();
  const parsed = JSON.parse(rawText) as T & { readonly error?: string };
  if (!res.ok) {
    throw new Error(parsed.error || `HTTP ${res.status}`);
  }
  return parsed;
}

export async function getActiveWorkspaces(): Promise<readonly string[]> {
  const bridge = getBridge();
  if (!bridge?.getWorkspaceUris) return [];
  try {
    const uris = await bridge.getWorkspaceUris();
    return Array.isArray(uris) ? uris.map((u) => normalizeUriToPath(String(u))).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function subscribeWorkspaces(cb: (paths: readonly string[]) => void): () => void {
  const bridge = getBridge();
  if (!bridge?.onWorkspaceChange) return () => {};
  return bridge.onWorkspaceChange((uris) => {
    cb(Array.isArray(uris) ? uris.map((u) => normalizeUriToPath(String(u))).filter(Boolean) : []);
  });
}

export function toggleConversation(convId: string): boolean {
  const fn = getBridge()?.ui?.toggleConversation;
  if (!fn || !convId) return false;
  fn(convId);
  return true;
}

export async function sendAgentMessage(message: string): Promise<boolean> {
  const fn = getBridge()?.agent?.sendMessage;
  if (!fn || !message.trim()) return false;
  await fn(message);
  return true;
}

export function fetchState(workspaces: ReadonlyArray<string>): Promise<LockBoardState> {
  const qs = workspaces.length > 0
    ? `?workspaces=${encodeURIComponent(JSON.stringify(workspaces))}`
    : '';
  return requestJson<LockBoardState>(`/api/state${qs}`);
}

export function postUnlock(
  moduleKey: string,
  expiredOnly: boolean,
  workspaces: ReadonlyArray<string>
): Promise<{ readonly ok: boolean; readonly state?: LockBoardState }> {
  return requestJson('/api/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moduleKey, expiredOnly, workspaces }),
  });
}

export function postQueueCancel(
  id: number,
  workspaces: ReadonlyArray<string>
): Promise<{ readonly ok: boolean; readonly state?: LockBoardState }> {
  return requestJson('/api/queue/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspaces }),
  });
}

export function postAutoWake(
  enabled: boolean,
  workspaces: ReadonlyArray<string>
): Promise<{ readonly ok: boolean; readonly state?: LockBoardState }> {
  return requestJson('/api/auto-wake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, workspaces }),
  });
}

export function postWake(
  id: number,
  workspaces: ReadonlyArray<string>
): Promise<{ readonly ok: boolean; readonly sent?: boolean; readonly error?: string; readonly state?: LockBoardState }> {
  return requestJson('/api/wake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspaces }),
  });
}

export function fetchXrayUml(
  workspace: string,
  mode: UmlMode,
  focus: string,
  hops: number
): Promise<UmlGraphResponse> {
  const params = new URLSearchParams({ workspace, mode, hops: String(hops) });
  if (focus) params.set('focus', focus);
  return requestJson<UmlGraphResponse>(`/api/xray/uml?${params.toString()}`);
}

export function postXrayRefresh(
  workspace: string,
  workspaces: ReadonlyArray<string>
): Promise<XrayActionResponse> {
  return requestJson('/api/xray/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, workspaces }),
  });
}

export function postXrayCheck(
  workspace: string,
  workspaces: ReadonlyArray<string>
): Promise<XrayActionResponse> {
  return requestJson('/api/xray/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, workspaces }),
  });
}
