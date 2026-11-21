/**
 * Auto-projected Antigravity Kanban board builder from locks, claims, queue, events,
 * and `<brainDir>/<convId>/.system_generated/` telemetry.
 */

import { basename } from 'node:path';
import {
  collectBrainDirIndex,
  defaultBrainRoots,
  parseChecklistMarkdown,
  readSessionTelemetry,
} from './telemetry_readers.mjs';

export { defaultBrainRoots, parseChecklistMarkdown, readSessionTelemetry };

const SHORT_ID_LEN = 8;

function ensureEntry(sessionMap, convId, now) {
  let entry = sessionMap.get(convId);
  if (!entry) {
    entry = {
      convId,
      shortId: convId.slice(0, SHORT_ID_LEN),
      title: '',
      workspaceName: '',
      modules: new Set(),
      heldFiles: [],
      lockModes: new Set(),
      queueItems: [],
      hasReleaseEvent: false,
      stallStatus: 'active',
      updatedAt: 0,
      fromLockOrQueue: false,
      idleSeconds: null,
      subagentIds: new Set(),
    };
    sessionMap.set(convId, entry);
  }
  if (!entry.updatedAt) entry.updatedAt = now;
  return entry;
}

function ingestSignals(sessionMap, brainIndex, { locks, claims, queue, events, now }) {
  for (const c of claims) {
    const convId = String(c.ownerId || '').trim();
    if (!convId) continue;
    const entry = ensureEntry(sessionMap, convId, c.lastActiveAt || now);
    entry.fromLockOrQueue = true;
    entry.title = entry.title || c.ownerTitle || '';
    entry.workspaceName = entry.workspaceName || c.ownerWorkspaceName || basename(c.workspace || '');
    if (c.moduleKey) entry.modules.add(c.moduleKey);
    if (c.lockMode) entry.lockModes.add(c.lockMode);
    for (const cid of c.childIds || []) entry.subagentIds.add(cid);
    entry.heldFiles.push({
      moduleKey: c.moduleKey,
      lockMode: c.lockMode || 'BUILD_EXCL',
      fileRelpath: c.fileRelpath || '',
    });
    entry.updatedAt = Math.max(entry.updatedAt, Number(c.lastActiveAt || now));
    entry.idleSeconds = c.idleSeconds ?? entry.idleSeconds;
  }

  for (const lk of locks) {
    const convId = String(lk.ownerId || '').trim();
    if (!convId) continue;
    const entry = ensureEntry(sessionMap, convId, lk.lastActiveAt || now);
    entry.fromLockOrQueue = true;
    entry.title = entry.title || lk.ownerTitle || '';
    entry.workspaceName = entry.workspaceName || lk.ownerWorkspaceName || basename(lk.workspace || '');
    if (lk.moduleKey) entry.modules.add(lk.moduleKey);
    for (const cid of lk.childIds || []) entry.subagentIds.add(cid);
    if (lk.activity?.status === 'stalled' || lk.activity?.status === 'stale') {
      entry.stallStatus = lk.activity.status;
    }
    entry.updatedAt = Math.max(entry.updatedAt, Number(lk.lastActiveAt || now));
    if (entry.idleSeconds === null && typeof lk.idleSeconds === 'number') {
      entry.idleSeconds = lk.idleSeconds;
    }
  }

  for (const q of queue) {
    const convId = String(q.waiterConvId || '').trim();
    if (!convId) continue;
    const entry = ensureEntry(sessionMap, convId, q.updatedAt || now);
    entry.fromLockOrQueue = true;
    entry.title = entry.title || q.waiterTitle || '';
    entry.workspaceName = entry.workspaceName || q.waiterWorkspaceName || basename(q.waiterWorkspace || '');
    if (q.moduleKey) entry.modules.add(q.moduleKey);
    if (q.lockMode) entry.lockModes.add(q.lockMode);
    entry.queueItems.push(q);
    entry.updatedAt = Math.max(entry.updatedAt, Number(q.updatedAt || q.requestedAt || now));
  }

  for (const ev of events) {
    const convId = String(ev.convId || '').trim();
    if (!convId || !['RELEASE', 'RELEASE_BARRIER', 'UNLOCK', 'TTL_EXPIRED'].includes(ev.event)) continue;
    if (now - Number(ev.ts || 0) > 2 * 3600) continue;
    const entry = ensureEntry(sessionMap, convId, Number(ev.ts || now));
    entry.hasReleaseEvent = true;
    entry.title = entry.title || ev.convTitle || '';
    entry.workspaceName = entry.workspaceName || ev.convWorkspaceName || '';
    for (const mk of String(ev.moduleKey || '').split(',').filter(Boolean)) entry.modules.add(mk.trim());
    entry.updatedAt = Math.max(entry.updatedAt, Number(ev.ts || now));
  }

  for (const [convId, binfo] of brainIndex.entries()) {
    if (binfo.isRecent || sessionMap.has(convId)) {
      ensureEntry(sessionMap, convId, binfo.mtimeMs / 1000);
    }
  }
}

function deriveColumn(entry, telemetry, now) {
  if (entry.queueItems.some((q) => q.status === 'waiting')) return 'blocked';
  if (entry.stallStatus === 'stalled' || entry.stallStatus === 'stale') return 'blocked';
  if (entry.heldFiles.length > 0) return 'in_progress';
  if ((telemetry?.checklist?.counts?.doing || 0) > 0 || (telemetry?.taskLogs?.running || 0) > 0) {
    return 'in_progress';
  }
  if (entry.queueItems.some((q) => q.status === 'promoted')) return 'todo';

  const counts = telemetry?.checklist?.counts;
  if (counts && counts.total > 0) {
    return counts.done === counts.total ? 'done' : 'todo';
  }
  if (entry.hasReleaseEvent) return 'done';
  if (telemetry?.updatedAtSec && now - telemetry.updatedAtSec <= 300) return 'in_progress';
  return 'done';
}

export function buildBoardTasks({
  locks = [],
  claims = [],
  queue = [],
  events = [],
  summaryMap = new Map(),
  summaryLookup = null,
  brainRoots = defaultBrainRoots(),
  now = Date.now() / 1000,
} = {}) {
  const nowMs = now * 1000;
  const sessionMap = new Map();
  const brainIndex = collectBrainDirIndex(brainRoots, nowMs);
  ingestSignals(sessionMap, brainIndex, { locks, claims, queue, events, now });

  const missingIds = [...sessionMap.keys()].filter((id) => !summaryMap.has(id));
  const extraSummaries = typeof summaryLookup === 'function' && missingIds.length > 0
    ? summaryLookup(missingIds)
    : new Map();

  const tasks = [];
  const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0 };

  for (const entry of sessionMap.values()) {
    const binfo = brainIndex.get(entry.convId);
    const telemetry = binfo ? readSessionTelemetry(binfo.full, nowMs) : null;
    if (
      !entry.fromLockOrQueue &&
      !entry.hasReleaseEvent &&
      !telemetry?.checklist?.counts?.total &&
      !telemetry?.taskLogs?.total
    ) {
      continue;
    }

    const summary = summaryMap.get(entry.convId) || extraSummaries?.get?.(entry.convId);
    const title =
      entry.title ||
      summary?.title ||
      telemetry?.checklist?.title ||
      telemetry?.transcript?.lastUserPrompt ||
      entry.shortId;
    const workspaceName = entry.workspaceName || summary?.workspaceName || '';
    const status = deriveColumn(entry, telemetry, now);
    counts[status] += 1;

    const modList = [...entry.modules];
    const where = modList.length > 0 ? modList.join(', ') : workspaceName || 'Workspace';
    const waitingFirst = entry.queueItems.find((q) => q.status === 'waiting');
    const blockedReason = waitingFirst
      ? `Queue #${waitingFirst.position || 1} on ${waitingFirst.moduleKey}`
      : entry.stallStatus !== 'active'
        ? `Session ${entry.stallStatus} (${entry.idleSeconds ?? 0}s idle)`
        : '';

    tasks.push({
      id: entry.convId,
      shortId: entry.shortId,
      title,
      status,
      where,
      workspaceName,
      modules: modList,
      lockModes: [...entry.lockModes],
      heldFiles: entry.heldFiles,
      todos: telemetry?.checklist?.todos || [],
      todoCounts: telemetry?.checklist?.counts || { total: 0, todo: 0, doing: 0, done: 0 },
      blockedReason,
      subagentCount: Math.max(entry.subagentIds.size, telemetry?.subagents?.total || 0),
      subagentRoles: telemetry?.subagents?.roles || [],
      activeTaskLogs: telemetry?.taskLogs?.running || 0,
      updatedAt: Math.max(entry.updatedAt, telemetry?.updatedAtSec || 0),
      idleSeconds: entry.idleSeconds,
    });
  }

  const orderWeight = { blocked: 0, in_progress: 1, todo: 2, done: 3 };
  tasks.sort((a, b) => (orderWeight[a.status] - orderWeight[b.status]) || (b.updatedAt - a.updatedAt));
  return { tasks, counts };
}
