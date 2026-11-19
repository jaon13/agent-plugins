/**
 * Background 1-second watchdog for expired locks and hook-deferred promotion wakes,
 * plus CLI `project_lock.py unlock` wrapper and `SidecarApp.sendMessage` / `agentapi` wake dispatcher.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_TTL_SECONDS,
  RESERVATION_TTL_SECONDS,
  claimPendingPromotedWakes,
  hasExpiredLocks,
  isAutoWakeEnabled,
  openLockDb,
  recordLockEvent,
  resolveLockDbPath,
  setQueueWakeStatus,
  sweepExpiredAndPromote,
} from './lock_db.mjs';

const execFileAsyncDefault = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WAKE_TIMEOUT_MS = 3000;
const UNLOCK_TIMEOUT_MS = 10000;
const MAX_ERR_DETAIL_LEN = 120;

export function resolveProjectLockScript(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  return resolve(__dirname, '..', '..', 'scripts', 'project_lock.py');
}

export function resolvePythonExe() {
  return (
    process.env.PROJECT_LOCK_PYTHON?.trim() ||
    process.env.PYTHON?.trim() ||
    'python'
  );
}

export function buildWakeMessage(promo) {
  const modsStr = Array.isArray(promo.modules) ? promo.modules.join(',') : '';
  return (
    `[ProjectLock] 대기 중이던 모듈(${modsStr}) 락이 해제되어 60초 예약` +
    `(group=${promo.requestGroupId})으로 승계되었습니다. ` +
    '중단했던 작업을 재개하세요.'
  );
}

export async function runProjectLockUnlock({
  moduleKey = '',
  expiredOnly = false,
  scriptPath = resolveProjectLockScript(),
  pythonExe = resolvePythonExe(),
  env = process.env,
  execFileFn = execFileAsyncDefault,
} = {}) {
  if (!existsSync(scriptPath)) {
    throw new Error(`project_lock.py not found at ${scriptPath}`);
  }

  const args = [scriptPath, 'unlock'];
  if (expiredOnly) {
    args.push('--expired');
  } else {
    const cleanMod = String(moduleKey ?? '').trim();
    if (!cleanMod) {
      throw new Error('moduleKey is required');
    }
    args.push('--module', cleanMod);
  }

  const { stdout, stderr } = await execFileFn(pythonExe, args, {
    env,
    timeout: UNLOCK_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
  });

  return {
    stdout: String(stdout ?? '').trim(),
    stderr: String(stderr ?? '').trim(),
  };
}

export async function wakeSinglePromotion(
  db,
  promo,
  { app = null, env = process.env, execFileFn = execFileAsyncDefault } = {}
) {
  const modsStr = Array.isArray(promo.modules) ? promo.modules.join(',') : '';
  const waiterConvId = String(promo.waiterConvId ?? '').trim();

  if (!waiterConvId || waiterConvId === 'unknown') {
    recordLockEvent(db, {
      event: 'WAKE_FAILED',
      moduleKey: modsStr,
      convId: waiterConvId,
      detail: 'missing waiter_conv_id',
    });
    setQueueWakeStatus(db, promo.requestGroupId, waiterConvId, 'failed');
    return false;
  }

  if (promo.sessionKind === 'cursor') {
    recordLockEvent(db, {
      event: 'WAKE_FAILED',
      moduleKey: modsStr,
      convId: waiterConvId,
      detail: 'external cursor session; resume manually',
    });
    setQueueWakeStatus(db, promo.requestGroupId, waiterConvId, 'failed');
    return false;
  }

  const message = buildWakeMessage(promo);

  try {
    if (app && typeof app.sendMessage === 'function') {
      await app.sendMessage(waiterConvId, message, {
        projectId: promo.waiterProjectId || undefined,
      });
    } else {
      const exe = String(env.ANTIGRAVITY_AGENTAPI_EXE ?? '').trim();
      if (!exe || !existsSync(exe)) {
        recordLockEvent(db, {
          event: 'WAKE_FAILED',
          moduleKey: modsStr,
          convId: waiterConvId,
          detail: 'ANTIGRAVITY_AGENTAPI_EXE not configured or missing',
        });
        setQueueWakeStatus(db, promo.requestGroupId, waiterConvId, 'failed');
        return false;
      }
      const wakeEnv = { ...env };
      if (promo.waiterProjectId) {
        wakeEnv.ANTIGRAVITY_PROJECT_ID = promo.waiterProjectId;
      }
      await execFileFn(exe, ['agentapi', 'send-message', waiterConvId, message], {
        env: wakeEnv,
        timeout: WAKE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
      });
    }

    recordLockEvent(db, {
      event: 'WAKE_SENT',
      moduleKey: modsStr,
      convId: waiterConvId,
      detail: `group=${promo.requestGroupId};project=${promo.waiterProjectId || ''}`,
    });
    setQueueWakeStatus(db, promo.requestGroupId, waiterConvId, 'sent');
    return true;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const cleaned = rawMsg.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_ERR_DETAIL_LEN);
    recordLockEvent(db, {
      event: 'WAKE_FAILED',
      moduleKey: modsStr,
      convId: waiterConvId,
      detail: `err=${cleaned}`,
    });
    setQueueWakeStatus(db, promo.requestGroupId, waiterConvId, 'failed');
    return false;
  }
}

export async function wakePromotions(
  db,
  promotions,
  {
    app = null,
    env = process.env,
    execFileFn = execFileAsyncDefault,
    bypassAutoSetting = false,
  } = {}
) {
  if (!Array.isArray(promotions) || promotions.length === 0) return [];
  if (!bypassAutoSetting && !isAutoWakeEnabled(db)) {
    for (const promo of promotions) {
      setQueueWakeStatus(db, promo.requestGroupId, promo.waiterConvId, 'disabled');
    }
    return [];
  }

  const results = [];
  const seen = new Set();
  for (const promo of promotions) {
    const key = `${promo.requestGroupId}|${promo.waiterConvId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ok = await wakeSinglePromotion(db, promo, { app, env, execFileFn });
    results.push({ promotion: promo, sent: ok });
  }
  return results;
}

export function createWatchdog({
  dbPath,
  app = null,
  intervalMs = 1000,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  reservationTtlSeconds = RESERVATION_TTL_SECONDS,
  env = process.env,
  execFileFn = execFileAsyncDefault,
  nowFn = () => Date.now() / 1000,
  onError,
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) {
      return { skipped: true, expiredKeys: [], promotions: [], wakeResults: [] };
    }
    const resolvedDbPath = resolveLockDbPath(dbPath);
    if (!existsSync(resolvedDbPath)) {
      return { skipped: false, expiredKeys: [], promotions: [], wakeResults: [] };
    }

    running = true;
    let db = null;
    try {
      db = openLockDb(resolvedDbPath);
      const now = nowFn();
      let expiredKeys = [];
      let sweptPromotions = [];
      if (hasExpiredLocks(db, { now, ttlSeconds })) {
        const swept = sweepExpiredAndPromote(db, {
          now,
          ttlSeconds,
          reservationTtlSeconds,
        });
        expiredKeys = swept.expiredKeys;
        sweptPromotions = swept.promotions;
      }

      const claimedPending = claimPendingPromotedWakes(db, { now });
      const promotions = [];
      const seen = new Set();
      for (const promo of [...sweptPromotions, ...claimedPending]) {
        const key = `${promo.requestGroupId}|${promo.waiterConvId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        promotions.push(promo);
      }

      const wakeResults = promotions.length
        ? await wakePromotions(db, promotions, { app, env, execFileFn })
        : [];
      return { skipped: false, expiredKeys, promotions, wakeResults };
    } catch (err) {
      if (typeof onError === 'function') {
        onError(err);
      }
      return {
        skipped: false,
        expiredKeys: [],
        promotions: [],
        wakeResults: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      running = false;
      try {
        db?.close();
      } catch {
        // Ignore close errors in background tick.
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
