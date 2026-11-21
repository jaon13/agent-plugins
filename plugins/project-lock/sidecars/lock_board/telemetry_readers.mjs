/**
 * Bounded read-only filesystem readers for `<brainDir>/<convId>/.system_generated/`
 * and Markdown checklists (`task.md`, `implementation_plan.md`).
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_RECENT_BRAIN_DIRS = 12;
const RECENT_BRAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const RUNNING_LOG_WINDOW_MS = 90 * 1000;
const TRANSCRIPT_TAIL_BYTES = 48 * 1024;
const MAX_CHECKLIST_BYTES = 64 * 1024;
const MAX_TODOS_PER_CARD = 14;
const BRAIN_INDEX_CACHE_MS = 15 * 1000;
const LARGE_BRAIN_ROOT_THRESHOLD = 40;

const brainRootDirCache = new Map();

export function defaultBrainRoots(homeDir = homedir()) {
  return [
    join(homeDir, '.gemini', 'antigravity', 'brain'),
    join(homeDir, '.gemini', 'antigravity-ide', 'brain'),
    join(homeDir, '.gemini', 'antigravity-cli', 'brain'),
  ];
}

export function parseChecklistMarkdown(rawText) {
  const todos = [];
  let title = '';
  let todoCount = 0;
  let doingCount = 0;
  let doneCount = 0;

  for (const line of String(rawText || '').split(/\r?\n/)) {
    if (!title) {
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) title = h1[1].trim().slice(0, 80);
    }
    const m = line.match(/^\s*[-*]\s+\[([ xX/])\]\s+(.+)$/);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const text = m[2].trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!text) continue;
    const state = mark === 'x' ? 'done' : mark === '/' ? 'doing' : 'todo';
    if (state === 'done') doneCount += 1;
    else if (state === 'doing') doingCount += 1;
    else todoCount += 1;
    if (todos.length < MAX_TODOS_PER_CARD) todos.push({ state, text });
  }

  return {
    title,
    todos,
    counts: { total: todoCount + doingCount + doneCount, todo: todoCount, doing: doingCount, done: doneCount },
  };
}

function readBoundedHead(filePath, maxBytes = MAX_CHECKLIST_BYTES) {
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return '';
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.allocUnsafe(size);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buf, 0, size, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on read-only file descriptors.
      }
    }
  }
}

function readTranscriptTail(transcriptPath) {
  let fd;
  try {
    const st = statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return null;
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(transcriptPath, 'r');
    const bytesRead = readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf-8', 0, bytesRead).split(/\r?\n/);
    if (start > 0 && lines.length > 0) lines.shift();

    let lastUserPrompt = '';
    let lastStepType = '';
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj?.type) lastStepType = String(obj.type);
        if (obj?.type === 'USER_INPUT' && obj?.content) {
          lastUserPrompt = String(obj.content).replace(/\s+/g, ' ').trim().slice(0, 72);
        }
      } catch {
        // Skip partial JSONL line near chunk boundary.
      }
    }
    return { mtimeMs: st.mtimeMs, lastUserPrompt, lastStepType };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on read-only file descriptors.
      }
    }
  }
}

function inspectSubagentsDir(subagentsDir) {
  if (!existsSync(subagentsDir)) return { total: 0, roles: [] };
  const roles = [];
  let total = 0;
  try {
    for (const ent of readdirSync(subagentsDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      total += 1;
      if (roles.length < 4) {
        try {
          const parsed = JSON.parse(readFileSync(join(subagentsDir, ent.name), 'utf-8'));
          roles.push(String(parsed?.role || parsed?.typeName || ent.name.replace(/\.json$/, '')));
        } catch {
          roles.push(ent.name.replace(/\.json$/, ''));
        }
      }
    }
  } catch {
    return { total, roles };
  }
  return { total, roles };
}

function inspectTaskLogsDir(tasksDir, nowMs) {
  if (!existsSync(tasksDir)) return { total: 0, running: 0, latestMtimeMs: 0 };
  let total = 0;
  let running = 0;
  let latestMtimeMs = 0;
  try {
    for (const ent of readdirSync(tasksDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      total += 1;
      const st = statSync(join(tasksDir, ent.name));
      if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs;
      if (nowMs - st.mtimeMs <= RUNNING_LOG_WINDOW_MS) running += 1;
    }
  } catch {
    return { total, running, latestMtimeMs };
  }
  return { total, running, latestMtimeMs };
}

export function readSessionTelemetry(convDir, nowMs = Date.now()) {
  if (!convDir || !existsSync(convDir)) return null;
  const sysDir = join(convDir, '.system_generated');
  const subagents = inspectSubagentsDir(join(sysDir, 'subagents'));
  const taskLogs = inspectTaskLogsDir(join(sysDir, 'tasks'), nowMs);
  const transcript = readTranscriptTail(join(sysDir, 'logs', 'transcript.jsonl'));

  const checklistPath = ['task.md', 'implementation_plan.md']
    .map((f) => join(convDir, f))
    .find((p) => existsSync(p));
  const checklist = checklistPath
    ? parseChecklistMarkdown(readBoundedHead(checklistPath))
    : { title: '', todos: [], counts: { total: 0, todo: 0, doing: 0, done: 0 } };

  let updatedAtMs = Math.max(taskLogs.latestMtimeMs, transcript?.mtimeMs || 0);
  try {
    if (checklistPath) updatedAtMs = Math.max(updatedAtMs, statSync(checklistPath).mtimeMs);
  } catch {
    // Ignore stat errors on transient files.
  }

  return {
    subagents,
    taskLogs,
    transcript,
    checklist,
    updatedAtSec: updatedAtMs > 0 ? updatedAtMs / 1000 : 0,
  };
}

function readRootBrainDirs(root, nowMs) {
  let rootMtimeMs = 0;
  try {
    rootMtimeMs = statSync(root).mtimeMs;
  } catch {
    return [];
  }

  const cached = brainRootDirCache.get(root);
  if (
    cached &&
    cached.dirs.length > LARGE_BRAIN_ROOT_THRESHOLD &&
    cached.rootMtimeMs === rootMtimeMs &&
    nowMs >= cached.cachedAtMs &&
    nowMs - cached.cachedAtMs < BRAIN_INDEX_CACHE_MS
  ) {
    return cached.dirs;
  }

  const rootDirs = [];
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const full = join(root, ent.name);
      rootDirs.push({ convId: ent.name, full, mtimeMs: statSync(full).mtimeMs });
    }
  } catch {
    return [];
  }

  if (rootDirs.length > LARGE_BRAIN_ROOT_THRESHOLD) {
    brainRootDirCache.set(root, { rootMtimeMs, cachedAtMs: nowMs, dirs: rootDirs });
  }
  return rootDirs;
}

export function collectBrainDirIndex(brainRoots, nowMs) {
  const dirs = [];
  for (const root of brainRoots || []) {
    if (!root || !existsSync(root)) continue;
    dirs.push(...readRootBrainDirs(root, nowMs));
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const map = new Map();
  let recentCount = 0;
  for (const item of dirs) {
    const isRecent = nowMs - item.mtimeMs <= RECENT_BRAIN_WINDOW_MS;
    if (!map.has(item.convId)) {
      map.set(item.convId, { ...item, isRecent: isRecent && recentCount < MAX_RECENT_BRAIN_DIRS });
      if (isRecent) recentCount += 1;
    }
  }
  return map;
}
