/**
 * Pure HTTP/JSON route controller for Lock & Tooling sidecar.
 * Zero dependency on `sidecar_sdk`, enabling fast testing with `node --test`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_LOCKS_PER_SESSION,
  DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS,
  DEFAULT_TTL_SECONDS,
  EVENT_LIMIT,
  STALL_LONG_SECONDS,
  STALL_SUSPECT_SECONDS,
  cancelQueueEntryById,
  claimPendingPromotedWakes,
  defaultSummaryDbPaths,
  openLockDb,
  prepareManualWakeByQueueId,
  readActiveClaims,
  readConversationSummaries,
  readDbSnapshot,
  resolveLockDbPath,
  setAutoWakeEnabled,
} from './lock_db.mjs';
import { buildBoardTasks } from './telemetry_board.mjs';
import { getToolingSnapshot, getXraySnapshot, parseWorkspacesParam } from './tooling_xray.mjs';
import { runXrayConsistencyCheck, runXrayRefresh } from './xray_actions.mjs';
import { buildFocusedUmlGraph } from './xray_uml.mjs';
import { runProjectLockUnlock, wakePromotions } from './watchdog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = existsSync(join(__dirname, 'dist', 'index.html'))
  ? join(__dirname, 'dist')
  : __dirname;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

function makeJsonResponse(payload, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload),
    json: payload,
  };
}

export function createLockBoardController({
  dbPath,
  toolingJsonPath,
  summaryDbPaths = defaultSummaryDbPaths(),
  staticDir = DEFAULT_STATIC_DIR,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  suspectSeconds,
  longSeconds,
  eventLimit = EVENT_LIMIT,
  includeGitDirty = true,
  gitChecker,
  activityChecker,
  unlockRunner = runProjectLockUnlock,
  wakeRunner,
  brainRoots,
  execRunner,
  homeDir,
  app = null,
  nowFn = () => Date.now() / 1000,
  env = process.env,
} = {}) {
  function getDbPath() {
    return resolveLockDbPath(dbPath);
  }

  function readStatic(routePath) {
    const entry = STATIC_FILES[routePath];
    if (!entry) return null;
    const [fileName, contentType] = entry;
    const body = readFileSync(join(staticDir, fileName), 'utf-8');
    return { status: 200, contentType, body };
  }

  async function buildStatePayload(query = {}) {
    const resolvedDbPath = getDbPath();
    const dbExists = existsSync(resolvedDbPath);
    const activeWorkspaces = parseWorkspacesParam(query.workspaces);
    const nowSec = nowFn();

    let dbSnap;
    let claims = [];
    if (dbExists) {
      const db = openLockDb(resolvedDbPath);
      try {
        dbSnap = await readDbSnapshot(db, {
          now: nowSec,
          ttlSeconds,
          suspectSeconds,
          longSeconds,
          eventLimit,
          includeGitDirty,
          gitChecker,
          activityChecker,
          summaryDbPaths,
        });
        claims = readActiveClaims(db, {
          now: nowSec,
          ttlSeconds,
          locks: dbSnap.locks,
        });
      } finally {
        db.close();
      }
    } else {
      dbSnap = {
        now: nowSec,
        autoWakeEnabled: true,
        guardSettings: {
          maxLocksPerSession: DEFAULT_MAX_LOCKS_PER_SESSION,
          maxSharedDepsWithoutNodeps: DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS,
        },
        stallSummary: {
          suspectSeconds: suspectSeconds ?? STALL_SUSPECT_SECONDS,
          longSeconds: longSeconds ?? STALL_LONG_SECONDS,
          stalledCount: 0,
          staleCount: 0,
          blockingStalledCount: 0,
        },
        locks: [],
        lock_queue: [],
        nextUp: [],
        lock_events: [],
      };
    }

    const summaryMap = new Map();
    for (const lk of dbSnap.locks) {
      if (lk.ownerId && (lk.ownerTitle || lk.ownerWorkspaceName)) {
        summaryMap.set(lk.ownerId, { title: lk.ownerTitle || '', workspaceName: lk.ownerWorkspaceName || '' });
      }
    }
    for (const q of dbSnap.lock_queue) {
      if (q.waiterConvId && (q.waiterTitle || q.waiterWorkspaceName)) {
        summaryMap.set(q.waiterConvId, { title: q.waiterTitle || '', workspaceName: q.waiterWorkspaceName || '' });
      }
    }

    const fallbackWorkspaces = [
      ...dbSnap.locks.map((lk) => lk.workspace).filter(Boolean),
      ...dbSnap.lock_queue.map((q) => q.waiterWorkspace).filter(Boolean),
    ];

    const tooling = getToolingSnapshot({ toolingJsonPath });
    const xray = getXraySnapshot({ activeWorkspaces, fallbackWorkspaces });
    const board = buildBoardTasks({
      locks: dbSnap.locks,
      claims,
      queue: dbSnap.lock_queue,
      events: dbSnap.lock_events,
      summaryMap,
      summaryLookup: (ids) => readConversationSummaries(ids, summaryDbPaths),
      brainRoots,
      now: dbSnap.now,
    });

    return {
      ...dbSnap,
      claims,
      claimCount: claims.length,
      boardTasks: board.tasks,
      boardCounts: board.counts,
      dbPath: resolvedDbPath,
      dbExists,
      tooling,
      xray,
    };
  }

  async function dispatchPendingAfterUnlock() {
    const resolvedDbPath = getDbPath();
    if (!existsSync(resolvedDbPath)) return [];
    const db = openLockDb(resolvedDbPath);
    try {
      const pending = claimPendingPromotedWakes(db, { now: nowFn() });
      if (!pending.length) return [];
      const runner =
        typeof wakeRunner === 'function'
          ? wakeRunner
          : (d, promos, opts) => wakePromotions(d, promos, opts);
      return await runner(db, pending, { app, env });
    } finally {
      db.close();
    }
  }

  async function handleGetState(data = {}) {
    const state = await buildStatePayload(data);
    return makeJsonResponse(state, 200);
  }

  async function handlePostUnlock(data = {}) {
    const expiredOnly = Boolean(data.expiredOnly);
    const moduleKey = String(data.moduleKey ?? data.module ?? '').trim();
    if (!expiredOnly && !moduleKey) {
      return makeJsonResponse({ ok: false, error: 'moduleKey is required' }, 400);
    }

    const runnerEnv = { ...env };
    if (dbPath) {
      runnerEnv.PROJECT_LOCK_DIR = dirname(getDbPath());
    }

    const result = await unlockRunner({
      moduleKey,
      expiredOnly,
      env: runnerEnv,
    });
    const wakeResults = await dispatchPendingAfterUnlock();
    const state = await buildStatePayload(data);
    return makeJsonResponse(
      {
        ok: true,
        moduleKey,
        expiredOnly,
        output: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
        wakeResults,
        state,
      },
      200
    );
  }

  async function handlePostQueueCancel(data = {}) {
    const resolvedDbPath = getDbPath();
    const db = openLockDb(resolvedDbPath);
    let outcome;
    try {
      outcome = cancelQueueEntryById(db, data.id);
    } finally {
      db.close();
    }

    if (!outcome.ok) {
      return makeJsonResponse(
        { ok: false, error: outcome.error },
        outcome.status || 400
      );
    }

    const state = await buildStatePayload(data);
    return makeJsonResponse({ ...outcome, state }, 200);
  }

  async function handlePostAutoWake(data = {}) {
    const resolvedDbPath = getDbPath();
    const db = openLockDb(resolvedDbPath);
    let targetEnabled;
    if (typeof data.enabled === 'boolean') {
      targetEnabled = data.enabled;
    } else if (data.value === '1' || data.value === '0') {
      targetEnabled = data.value === '1';
    }

    let result;
    try {
      result = setAutoWakeEnabled(db, targetEnabled);
    } finally {
      db.close();
    }

    const state = await buildStatePayload(data);
    return makeJsonResponse({ ...result, state }, 200);
  }

  async function handlePostWake(data = {}) {
    const resolvedDbPath = getDbPath();
    if (!existsSync(resolvedDbPath)) {
      return makeJsonResponse({ ok: false, error: 'Lock database does not exist' }, 404);
    }

    const db = openLockDb(resolvedDbPath);
    let prep;
    let sent = false;
    try {
      prep = prepareManualWakeByQueueId(db, data.id, { now: nowFn() });
      if (!prep.ok) {
        return makeJsonResponse(
          { ok: false, error: prep.error },
          prep.status || 400
        );
      }

      const runner =
        typeof wakeRunner === 'function'
          ? wakeRunner
          : (d, promos, opts) => wakePromotions(d, promos, opts);
      const wakeResults = await runner(db, [prep.promo], {
        app,
        env,
        bypassAutoSetting: true,
      });
      sent = Boolean(wakeResults?.[0]?.sent);
    } finally {
      db.close();
    }

    const state = await buildStatePayload(data);
    return makeJsonResponse(
      {
        ok: true,
        sent,
        promo: prep.promo,
        error: sent ? '' : '깨우기 메시지 전송에 실패했습니다. 대상 세션 상태를 확인하세요.',
        state,
      },
      200
    );
  }

  async function resolveTargetWorkspace(data = {}) {
    const state = await buildStatePayload(data);
    const explicit = String(data.workspace ?? '').trim();
    const allowedWorkspaces = (state.xray?.workspaces || []).map((w) => w.workspacePath).filter(Boolean);
    const chosen = explicit || allowedWorkspaces[0] || '';
    return { state, chosen, allowedWorkspaces };
  }

  async function handleGetXrayUml(data = {}) {
    const { chosen } = await resolveTargetWorkspace(data);
    if (!chosen) {
      return makeJsonResponse({ ok: false, error: 'No active workspace available', nodes: [], edges: [], availableTargets: [], mermaid: '' }, 400);
    }
    const graph = buildFocusedUmlGraph(chosen, {
      mode: String(data.mode || 'type'),
      focus: String(data.focus || ''),
      hops: Number(data.hops || 1),
    });
    return makeJsonResponse(graph, 200);
  }

  async function handlePostXrayRefresh(data = {}) {
    const { state, chosen, allowedWorkspaces } = await resolveTargetWorkspace(data);
    const result = await runXrayRefresh({
      workspacePath: chosen,
      tooling: state.tooling,
      allowedWorkspaces,
      execRunner,
      homeDir,
    });
    const nextState = result.ok ? await buildStatePayload(data) : state;
    return makeJsonResponse({ ...result, state: nextState }, result.status || 200);
  }

  async function handlePostXrayCheck(data = {}) {
    const { chosen, allowedWorkspaces } = await resolveTargetWorkspace(data);
    const result = await runXrayConsistencyCheck({
      workspacePath: chosen,
      allowedWorkspaces,
      execRunner,
      homeDir,
    });
    return makeJsonResponse(result, result.status || 200);
  }

  return {
    getDbPath,
    readStatic,
    buildStatePayload,
    handleGetState,
    handlePostUnlock,
    handlePostQueueCancel,
    handlePostAutoWake,
    handlePostWake,
    handleGetXrayUml,
    handlePostXrayRefresh,
    handlePostXrayCheck,
  };
}

export function createStandaloneHttpServer(controller) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('/* standalone preload stub */');
      return;
    }

    if (method === 'GET') {
      const staticResp = controller.readStatic(url.pathname);
      if (staticResp) {
        res.writeHead(staticResp.status, { 'Content-Type': staticResp.contentType });
        res.end(staticResp.body);
        return;
      }
    }

    const queryData = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (k.toLowerCase() !== 'token') queryData[k] = v;
    }

    let bodyRaw = '';
    req.on('data', (chunk) => {
      bodyRaw += chunk;
    });
    req.on('end', async () => {
      try {
        const data = { ...queryData };
        if (bodyRaw.trim()) {
          Object.assign(data, JSON.parse(bodyRaw));
        }

        let resp = null;
        if (method === 'GET' && url.pathname === '/api/state') {
          resp = await controller.handleGetState(data);
        } else if (method === 'GET' && url.pathname === '/api/xray/uml') {
          resp = await controller.handleGetXrayUml(data);
        } else if (method === 'POST' && url.pathname === '/api/xray/refresh') {
          resp = await controller.handlePostXrayRefresh(data);
        } else if (method === 'POST' && url.pathname === '/api/xray/check') {
          resp = await controller.handlePostXrayCheck(data);
        } else if (method === 'POST' && url.pathname === '/api/unlock') {
          resp = await controller.handlePostUnlock(data);
        } else if (method === 'POST' && url.pathname === '/api/queue/cancel') {
          resp = await controller.handlePostQueueCancel(data);
        } else if (method === 'POST' && url.pathname === '/api/auto-wake') {
          resp = await controller.handlePostAutoWake(data);
        } else if (method === 'POST' && url.pathname === '/api/wake') {
          resp = await controller.handlePostWake(data);
        }

        if (!resp) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Not Found' }));
          return;
        }

        res.writeHead(resp.status, { 'Content-Type': resp.contentType });
        res.end(resp.body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    });
  });
}
