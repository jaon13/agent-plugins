/**
 * SQLite WAL persistence, snapshot queries, git status probe, and atomic
 * reservation expiration/promotion for ProjectLock (`locks.db`).
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_TTL_SECONDS = 1200;
export const RESERVATION_TTL_SECONDS = 60;
export const STALL_SUSPECT_SECONDS = 180;
export const STALL_LONG_SECONDS = 600;
export const DEFAULT_MAX_LOCKS_PER_SESSION = 4;
export const DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS = 3;
export const BUSY_TIMEOUT_MS = 5000;
export const EVENT_LIMIT = 40;
const GIT_TIMEOUT_MS = 1500;
const GIT_CACHE_TTL_MS = 4000;

function loadWorkspaceLockConfig(dbPath = resolveLockDbPath()) {
  const cfgPath =
    process.env.PROJECT_LOCK_CONFIG?.trim() || join(dirname(resolve(dbPath)), 'config.json');
  let raw = {};
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = {};
    }
  }
  const toLowerSet = (arr) =>
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => String(x || '').trim().toLowerCase())
        .filter(Boolean)
    );
  const sharedSrcGroups = toLowerSet(raw.sharedSrcGroups);
  const sharedStdGroups = toLowerSet(raw.sharedGroups);
  return {
    workspaceRoot:
      process.env.PROJECT_LOCK_WORKSPACE_ROOT?.trim() || String(raw.workspaceRoot || '').trim(),
    sharedSrcGroups,
    sharedGroups: new Set([...sharedSrcGroups, ...sharedStdGroups]),
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS locks (
  module_key TEXT PRIMARY KEY,
  module_root TEXT NOT NULL,
  is_shared INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL,
  owner_project_id TEXT NOT NULL DEFAULT '',
  owner_transcript TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  child_ids_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  acquired_at REAL NOT NULL,
  last_active_at REAL NOT NULL,
  reserved_until REAL
);

CREATE TABLE IF NOT EXISTS lock_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_group_id TEXT NOT NULL,
  module_key TEXT NOT NULL,
  waiter_conv_id TEXT NOT NULL,
  waiter_project_id TEXT NOT NULL DEFAULT '',
  waiter_workspace TEXT NOT NULL DEFAULT '',
  session_kind TEXT NOT NULL DEFAULT 'unknown',
  reason_tag TEXT NOT NULL DEFAULT 'edit',
  status TEXT NOT NULL DEFAULT 'waiting',
  wake_status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  requested_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  UNIQUE(module_key, waiter_conv_id)
);

CREATE INDEX IF NOT EXISTS idx_lock_queue_module_status_id
  ON lock_queue(module_key, status, id);

CREATE INDEX IF NOT EXISTS idx_lock_queue_group
  ON lock_queue(request_group_id, waiter_conv_id);

CREATE TABLE IF NOT EXISTS lock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  event TEXT NOT NULL,
  module_key TEXT NOT NULL DEFAULT '',
  conv_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_lock_events_ts ON lock_events(ts DESC);

CREATE TABLE IF NOT EXISTS lock_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const gitDirtyCache = new Map();

export function resolveLockDbPath(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const envDir = process.env.PROJECT_LOCK_DIR?.trim();
  if (envDir) return join(resolve(envDir), 'locks.db');
  return join(homedir(), '.agents', 'locks', 'locks.db');
}

export function openLockDb(dbPath = resolveLockDbPath(), { readOnly = false } = {}) {
  if (readOnly) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    return db;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  ensureLockSchema(db);
  return db;
}

export function ensureLockSchema(db) {
  db.exec(SCHEMA_SQL);
  const cols = db.prepare('PRAGMA table_info(lock_queue)').all();
  if (!cols.some((col) => String(col.name ?? '') === 'wake_status')) {
    db.exec("ALTER TABLE lock_queue ADD COLUMN wake_status TEXT NOT NULL DEFAULT 'pending'");
  }
  const seedSettingStmt = db.prepare(
    'INSERT OR IGNORE INTO lock_settings (key, value) VALUES (?, ?)'
  );
  seedSettingStmt.run('auto_wake_enabled', '1');
  seedSettingStmt.run('max_locks_per_session', String(DEFAULT_MAX_LOCKS_PER_SESSION));
  seedSettingStmt.run(
    'max_shared_deps_without_nodeps',
    String(DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS)
  );
}

export function withWriteTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors after failed commit/transaction.
    }
    throw err;
  }
}

function safeParseStrList(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function toNumber(val, fallback = 0) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function toOptNumber(val) {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function mapLockRow(row, now, ttlSeconds) {
  const acquiredAt = toNumber(row.acquired_at, now);
  const lastActiveAt = toNumber(row.last_active_at, acquiredAt);
  const reservedUntil = toOptNumber(row.reserved_until);
  const isReserved = reservedUntil !== null;
  const idleSeconds = Math.max(0, Math.floor(now - lastActiveAt));
  const reservedRemainingSeconds = isReserved
    ? Math.max(0, Math.ceil(reservedUntil - now))
    : null;
  const ttlRemainingSeconds = isReserved
    ? reservedRemainingSeconds
    : Math.max(0, Math.ceil(ttlSeconds - (now - lastActiveAt)));

  return {
    moduleKey: String(row.module_key ?? ''),
    moduleRoot: String(row.module_root ?? ''),
    isShared: Boolean(row.is_shared),
    ownerId: String(row.owner_id ?? ''),
    ownerProjectId: String(row.owner_project_id ?? ''),
    ownerTranscriptPath: String(row.owner_transcript ?? ''),
    workspace: String(row.workspace ?? ''),
    childIds: safeParseStrList(row.child_ids_json),
    tags: safeParseStrList(row.tags_json),
    acquiredAt,
    lastActiveAt,
    reservedUntil,
    isReserved,
    idleSeconds,
    ttlSeconds,
    ttlRemainingSeconds,
    reservedRemainingSeconds,
    gitDirty: null,
  };
}

function mapQueueRow(row, position = 0) {
  return {
    id: Number(row.id),
    requestGroupId: String(row.request_group_id ?? ''),
    moduleKey: String(row.module_key ?? ''),
    waiterConvId: String(row.waiter_conv_id ?? ''),
    waiterProjectId: String(row.waiter_project_id ?? ''),
    waiterWorkspace: String(row.waiter_workspace ?? ''),
    sessionKind: String(row.session_kind ?? 'unknown'),
    reasonTag: String(row.reason_tag ?? 'edit'),
    status: String(row.status ?? 'waiting'),
    wakeStatus: String(row.wake_status || 'pending'),
    retryCount: Number(row.retry_count ?? 0),
    requestedAt: toNumber(row.requested_at, 0),
    updatedAt: toNumber(row.updated_at, 0),
    position,
    reservedUntil: null,
    reservedRemainingSeconds: null,
  };
}

function mapEventRow(row) {
  return {
    id: Number(row.id),
    ts: toNumber(row.ts, 0),
    event: String(row.event ?? ''),
    moduleKey: String(row.module_key ?? ''),
    convId: String(row.conv_id ?? ''),
    detail: String(row.detail ?? ''),
  };
}

function logEventTx(db, event, moduleKey = '', convId = '', detail = '', ts = Date.now() / 1000) {
  db.prepare(
    'INSERT INTO lock_events (ts, event, module_key, conv_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(ts, event, moduleKey, convId, detail);
}

function isRowExpired(row, now, ttlSeconds) {
  const resUntil = toOptNumber(row.reserved_until);
  if (resUntil !== null) {
    return now >= resUntil;
  }
  const lastActive = toNumber(row.last_active_at, now);
  return (now - lastActive) > ttlSeconds;
}

function isSameOwnerTree(lockItem, convId) {
  if (!convId) return false;
  if (lockItem.ownerId === convId) return true;
  return Array.isArray(lockItem.childIds) && lockItem.childIds.includes(convId);
}

function inferModuleMeta(moduleKey, fallbackWorkspace = '', cfg = loadWorkspaceLockConfig()) {
  const newRoot = cfg.workspaceRoot;
  const parts = String(moduleKey || '').split('/').filter(Boolean);
  const group = (parts[0] || '').toLowerCase();
  const isShared = cfg.sharedGroups.has(group);
  if (newRoot && parts.length && !isAbsolute(moduleKey)) {
    const candidate = cfg.sharedSrcGroups.has(group) && parts[1] && parts[1] !== '_root'
      ? join(newRoot, parts[0], 'src', parts[1])
      : join(newRoot, ...parts);
    if (existsSync(candidate) || !fallbackWorkspace) {
      return { moduleRoot: candidate, isShared };
    }
  }
  return {
    moduleRoot: fallbackWorkspace || moduleKey,
    isShared,
  };
}

function loadActiveLocksMapTx(db, now, ttlSeconds) {
  const rows = db.prepare('SELECT * FROM locks ORDER BY module_key ASC').all();
  const map = new Map();
  for (const row of rows) {
    if (!isRowExpired(row, now, ttlSeconds)) {
      const mapped = mapLockRow(row, now, ttlSeconds);
      map.set(mapped.moduleKey, mapped);
    }
  }
  return map;
}

function promoteNextForModuleTx(db, moduleKey, now, ttlSeconds, reservationTtlSeconds, metaCache) {
  const waiters = db.prepare(
    "SELECT * FROM lock_queue WHERE module_key = ? AND status = 'waiting' ORDER BY id ASC"
  ).all(moduleKey);
  if (!waiters.length) return null;

  const activeLocks = loadActiveLocksMapTx(db, now, ttlSeconds);
  const groupStmt = db.prepare(
    "SELECT * FROM lock_queue WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'waiting' ORDER BY id ASC"
  );
  const insertLockStmt = db.prepare(`
    INSERT OR REPLACE INTO locks (
      module_key, module_root, is_shared, owner_id, owner_project_id,
      owner_transcript, workspace, child_ids_json, tags_json,
      acquired_at, last_active_at, reserved_until
    ) VALUES (?, ?, ?, ?, ?, '', ?, '[]', ?, ?, ?, ?)
  `);
  const updateQueueStmt = db.prepare(
    "UPDATE lock_queue SET status = 'promoted', wake_status = 'pending', updated_at = ? WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'waiting'"
  );

  for (const row of waiters) {
    const reqGroup = String(row.request_group_id ?? '');
    const waiterId = String(row.waiter_conv_id ?? '');
    const groupRows = groupStmt.all(reqGroup, waiterId);
    const groupKeys = groupRows.length
      ? groupRows.map((gr) => String(gr.module_key ?? ''))
      : [moduleKey];

    const blocked = groupKeys.some((gk) => {
      const held = activeLocks.get(gk);
      return held !== undefined && !isSameOwnerTree(held, waiterId);
    });
    if (blocked) continue;

    const waiterProj = String(row.waiter_project_id ?? '');
    const waiterWs = String(row.waiter_workspace ?? '');
    const sessionKind = String(row.session_kind ?? 'unknown');
    const reasonTag = String(row.reason_tag ?? 'edit') || 'edit';
    const resUntil = now + reservationTtlSeconds;

    for (const gk of groupKeys) {
      if (activeLocks.has(gk)) continue;
      const cached = metaCache.get(gk);
      const meta = cached || inferModuleMeta(gk, waiterWs);
      const tags = reasonTag !== 'reserved' ? [reasonTag, 'reserved'] : ['reserved'];
      insertLockStmt.run(
        gk,
        meta.moduleRoot,
        meta.isShared ? 1 : 0,
        waiterId,
        waiterProj,
        waiterWs,
        JSON.stringify(tags),
        now,
        now,
        resUntil
      );
    }

    updateQueueStmt.run(now, reqGroup, waiterId);
    logEventTx(
      db,
      'PROMOTED',
      groupKeys.join(','),
      waiterId,
      `group=${reqGroup};reserved_until=${resUntil.toFixed(3)}`,
      now
    );

    return {
      requestGroupId: reqGroup,
      modules: groupKeys,
      waiterConvId: waiterId,
      waiterProjectId: waiterProj,
      waiterWorkspace: waiterWs,
      sessionKind,
      reasonTag,
      reservedUntil: resUntil,
    };
  }

  return null;
}

export function hasExpiredLocks(
  db,
  { now = Date.now() / 1000, ttlSeconds = DEFAULT_TTL_SECONDS } = {}
) {
  const cutoff = now - ttlSeconds;
  const row = db.prepare(`
    SELECT 1 AS hit FROM locks
    WHERE (reserved_until IS NOT NULL AND reserved_until <= ?)
       OR (reserved_until IS NULL AND last_active_at < ?)
    LIMIT 1
  `).get(now, cutoff);
  return Boolean(row?.hit);
}

export function sweepExpiredAndPromote(
  db,
  {
    now = Date.now() / 1000,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    reservationTtlSeconds = RESERVATION_TTL_SECONDS,
  } = {}
) {
  return withWriteTx(db, () => {
    const rows = db.prepare('SELECT * FROM locks ORDER BY module_key ASC').all();
    const expiredKeys = [];
    const metaCache = new Map();

    const delPromotedStmt = db.prepare(
      "DELETE FROM lock_queue WHERE module_key = ? AND waiter_conv_id = ? AND status = 'promoted'"
    );
    const delLockStmt = db.prepare('DELETE FROM locks WHERE module_key = ?');

    for (const row of rows) {
      if (!isRowExpired(row, now, ttlSeconds)) continue;
      const modKey = String(row.module_key ?? '');
      const ownerId = String(row.owner_id ?? '');
      const resUntil = toOptNumber(row.reserved_until);
      metaCache.set(modKey, {
        moduleRoot: String(row.module_root ?? ''),
        isShared: Boolean(row.is_shared),
      });

      if (resUntil !== null) {
        logEventTx(
          db,
          'RESERVATION_EXPIRED',
          modKey,
          ownerId,
          `reserved_until=${resUntil.toFixed(3)}`,
          now
        );
      } else {
        const lastActive = toNumber(row.last_active_at, now);
        const idleS = Math.max(0, now - lastActive);
        logEventTx(db, 'TTL_EXPIRED', modKey, ownerId, `idle=${idleS.toFixed(1)}s`, now);
      }

      delPromotedStmt.run(modKey, ownerId);
      delLockStmt.run(modKey);
      expiredKeys.push(modKey);
    }

    const promotions = [];
    const seenGroups = new Set();
    for (const modKey of expiredKeys) {
      const promo = promoteNextForModuleTx(
        db,
        modKey,
        now,
        ttlSeconds,
        reservationTtlSeconds,
        metaCache
      );
      if (promo) {
        const gkey = `${promo.requestGroupId}|${promo.waiterConvId}`;
        if (!seenGroups.has(gkey)) {
          seenGroups.add(gkey);
          promotions.push(promo);
        }
      }
    }

    return { expiredKeys, promotions };
  });
}

function parsePositiveIntSetting(raw, fallback) {
  const trimmed = String(raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function readGuardSettings(db) {
  const rows = db
    .prepare(
      "SELECT key, value FROM lock_settings WHERE key IN ('max_locks_per_session', 'max_shared_deps_without_nodeps')"
    )
    .all();
  const byKey = new Map(rows.map((r) => [String(r.key ?? ''), r.value]));
  return {
    maxLocksPerSession: parsePositiveIntSetting(
      byKey.get('max_locks_per_session'),
      DEFAULT_MAX_LOCKS_PER_SESSION
    ),
    maxSharedDepsWithoutNodeps: parsePositiveIntSetting(
      byKey.get('max_shared_deps_without_nodeps'),
      DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS
    ),
  };
}

export function isAutoWakeEnabled(db) {
  const row = db
    .prepare("SELECT value FROM lock_settings WHERE key = 'auto_wake_enabled'")
    .get();
  if (!row) return true;
  return String(row.value) === '1';
}

export function setAutoWakeEnabled(db, enabled) {
  return withWriteTx(db, () => {
    const nextBool =
      typeof enabled === 'boolean' ? enabled : !isAutoWakeEnabled(db);
    const nextVal = nextBool ? '1' : '0';
    db.prepare(
      "INSERT OR REPLACE INTO lock_settings (key, value) VALUES ('auto_wake_enabled', ?)"
    ).run(nextVal);
    logEventTx(db, 'AUTO_WAKE_TOGGLED', '', 'ui', `enabled=${nextVal}`);
    return {
      ok: true,
      autoWakeEnabled: nextBool,
      value: nextVal,
    };
  });
}

export function cancelQueueEntryById(db, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, error: 'Invalid queue entry id' };
  }

  return withWriteTx(db, () => {
    const row = db.prepare('SELECT * FROM lock_queue WHERE id = ?').get(id);
    if (!row) {
      return { ok: false, status: 404, error: `Queue entry #${id} not found` };
    }
    const res = db.prepare('DELETE FROM lock_queue WHERE id = ?').run(id);
    const moduleKey = String(row.module_key ?? '');
    const waiterConvId = String(row.waiter_conv_id ?? '');
    const groupId = String(row.request_group_id ?? '');
    if (res.changes > 0) {
      logEventTx(
        db,
        'QUEUE_CANCELLED',
        moduleKey,
        waiterConvId,
        `id=${id};group=${groupId}`
      );
    }
    return {
      ok: true,
      status: 200,
      cancelled: Number(res.changes),
      entry: { id, moduleKey, waiterConvId, requestGroupId: groupId },
    };
  });
}

export function recordLockEvent(
  db,
  { event, moduleKey = '', convId = '', detail = '', ts = Date.now() / 1000 }
) {
  return withWriteTx(db, () => {
    logEventTx(db, event, moduleKey, convId, detail, ts);
  });
}

export function setQueueWakeStatus(
  db,
  requestGroupId,
  waiterConvId,
  wakeStatus,
  now = Date.now() / 1000
) {
  if (!requestGroupId || !waiterConvId) return 0;
  return withWriteTx(db, () => {
    const res = db
      .prepare(
        'UPDATE lock_queue SET wake_status = ?, updated_at = ? WHERE request_group_id = ? AND waiter_conv_id = ?'
      )
      .run(wakeStatus, now, requestGroupId, waiterConvId);
    return Number(res.changes ?? 0);
  });
}

export function claimPendingPromotedWakes(db, { now = Date.now() / 1000 } = {}) {
  return withWriteTx(db, () => {
    const rows = db
      .prepare(
        `
        SELECT q.*
        FROM lock_queue q
        INNER JOIN locks l
          ON l.module_key = q.module_key
         AND l.owner_id = q.waiter_conv_id
        WHERE q.status = 'promoted'
          AND q.wake_status = 'pending'
          AND (l.reserved_until IS NULL OR l.reserved_until > ?)
        ORDER BY q.id ASC
        `
      )
      .all(now);

    if (!rows.length) return [];

    const grouped = new Map();
    for (const row of rows) {
      const reqGroup = String(row.request_group_id ?? '');
      const waiterId = String(row.waiter_conv_id ?? '');
      if (!reqGroup || !waiterId) continue;
      const key = `${reqGroup}|${waiterId}`;
      let entry = grouped.get(key);
      if (!entry) {
        entry = {
          requestGroupId: reqGroup,
          modules: [],
          waiterConvId: waiterId,
          waiterProjectId: String(row.waiter_project_id ?? ''),
          waiterWorkspace: String(row.waiter_workspace ?? ''),
          sessionKind: String(row.session_kind ?? 'unknown'),
          reasonTag: String(row.reason_tag ?? 'edit') || 'edit',
          reservedUntil: null,
        };
        grouped.set(key, entry);
      }
      const modKey = String(row.module_key ?? '');
      if (modKey && !entry.modules.includes(modKey)) {
        entry.modules.push(modKey);
      }
    }

    const claimStmt = db.prepare(
      "UPDATE lock_queue SET wake_status = 'sending', updated_at = ? WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'promoted' AND wake_status = 'pending'"
    );
    const claimed = [];
    for (const entry of grouped.values()) {
      const res = claimStmt.run(now, entry.requestGroupId, entry.waiterConvId);
      if (Number(res.changes ?? 0) > 0) {
        claimed.push(entry);
      }
    }
    return claimed;
  });
}

export function prepareManualWakeByQueueId(
  db,
  rawId,
  {
    now = Date.now() / 1000,
    reservationTtlSeconds = RESERVATION_TTL_SECONDS,
  } = {}
) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, error: 'Invalid queue entry id' };
  }

  return withWriteTx(db, () => {
    const row = db.prepare('SELECT * FROM lock_queue WHERE id = ?').get(id);
    if (!row) {
      return { ok: false, status: 404, error: `Queue entry #${id} not found` };
    }
    const status = String(row.status ?? 'waiting');
    if (status !== 'promoted') {
      return {
        ok: false,
        status: 409,
        error:
          '이 대기 세션은 아직 승계(Promoted)되지 않았습니다. 먼저 현재 락 보유 세션을 Unlock 하세요.',
      };
    }

    const reqGroup = String(row.request_group_id ?? '');
    const waiterId = String(row.waiter_conv_id ?? '');
    const groupRows = db
      .prepare(
        "SELECT * FROM lock_queue WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'promoted' ORDER BY id ASC"
      )
      .all(reqGroup, waiterId);

    const modules = groupRows
      .map((gr) => String(gr.module_key ?? ''))
      .filter(Boolean);
    if (!modules.length) {
      return { ok: false, status: 409, error: 'No promoted modules found for entry' };
    }

    const primaryLock = db
      .prepare('SELECT * FROM locks WHERE module_key = ? AND owner_id = ?')
      .get(modules[0], waiterId);
    if (!primaryLock) {
      return {
        ok: false,
        status: 409,
        error: '예약 락이 이미 만료되었거나 해제되었습니다.',
      };
    }

    const nextReservedUntil = now + reservationTtlSeconds;
    const extendStmt = db.prepare(
      'UPDATE locks SET reserved_until = ? WHERE module_key = ? AND owner_id = ?'
    );
    for (const mk of modules) {
      extendStmt.run(nextReservedUntil, mk, waiterId);
    }

    db.prepare(
      "UPDATE lock_queue SET wake_status = 'sending', updated_at = ? WHERE request_group_id = ? AND waiter_conv_id = ? AND status = 'promoted'"
    ).run(now, reqGroup, waiterId);

    return {
      ok: true,
      status: 200,
      promo: {
        requestGroupId: reqGroup,
        modules,
        waiterConvId: waiterId,
        waiterProjectId: String(row.waiter_project_id ?? ''),
        waiterWorkspace: String(row.waiter_workspace ?? ''),
        sessionKind: String(row.session_kind ?? 'unknown'),
        reasonTag: String(row.reason_tag ?? 'edit') || 'edit',
        reservedUntil: nextReservedUntil,
      },
    };
  });
}

export function defaultSummaryDbPaths(homeDir = homedir()) {
  const geminiRoot = join(homeDir, '.gemini');
  return [
    join(geminiRoot, 'antigravity', 'conversation_summaries.db'),
    join(geminiRoot, 'antigravity-ide', 'conversation_summaries.db'),
    join(geminiRoot, 'antigravity-cli', 'conversation_summaries.db'),
  ];
}

export function extractWorkspaceName(rawWorkspaceUris) {
  let candidate = String(rawWorkspaceUris ?? '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('[')) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const first = parsed.map((v) => String(v ?? '').trim()).find(Boolean);
        candidate = first ?? '';
      }
    } catch {
      // Fall back to raw candidate parsing.
    }
  }
  if (!candidate) return '';
  if (candidate.toLowerCase().startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname);
      } catch {
        // Keep raw candidate on malformed URI.
      }
    }
  }
  return basename(candidate) || candidate;
}

function readOneSummaryDb(dbPath, targetIds, results) {
  if (!targetIds.length || !dbPath || !existsSync(dbPath)) return;
  let sdb = null;
  try {
    sdb = new DatabaseSync(dbPath, { readOnly: true });
    sdb.exec('PRAGMA busy_timeout = 1000;');
    const placeholders = targetIds.map(() => '?').join(', ');
    const rows = sdb
      .prepare(
        `SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE conversation_id IN (${placeholders})`
      )
      .all(...targetIds);
    for (const row of rows) {
      const cid = String(row.conversation_id ?? '').trim();
      if (!cid || results.has(cid)) continue;
      results.set(cid, {
        title: String(row.title ?? '').trim(),
        workspaceName: extractWorkspaceName(row.workspace_uris),
      });
    }
  } catch {
    // Summary DB may be missing, locked, or schema-incompatible; skip gracefully.
  } finally {
    try {
      sdb?.close();
    } catch {
      // Ignore close failures on read-only summary DBs.
    }
  }
}

export function readConversationSummaries(
  convIds,
  summaryDbPaths = defaultSummaryDbPaths()
) {
  const uniqueIds = [];
  const seen = new Set();
  for (const rawId of convIds ?? []) {
    const cleaned = String(rawId ?? '').trim();
    if (!cleaned || cleaned === 'unknown' || seen.has(cleaned)) continue;
    seen.add(cleaned);
    uniqueIds.push(cleaned);
  }
  const results = new Map();
  if (!uniqueIds.length || !Array.isArray(summaryDbPaths)) return results;

  for (const dbPath of summaryDbPaths) {
    const remaining = uniqueIds.filter((cid) => !results.has(cid));
    if (!remaining.length) break;
    readOneSummaryDb(dbPath, remaining, results);
  }
  return results;
}

export async function checkGitDirtyCached(
  moduleRoot,
  { nowMs = Date.now(), cacheTtlMs = GIT_CACHE_TTL_MS, gitChecker } = {}
) {
  if (!moduleRoot || !existsSync(moduleRoot)) return null;

  const cached = gitDirtyCache.get(moduleRoot);
  if (cached && nowMs - cached.ts < cacheTtlMs) {
    return cached.dirty;
  }

  let dirty = null;
  if (typeof gitChecker === 'function') {
    dirty = await gitChecker(moduleRoot);
  } else {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', moduleRoot, 'status', '--porcelain', '--', '.'],
        {
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 256 * 1024,
        }
      );
      dirty = stdout.trim().length > 0;
    } catch {
      dirty = null;
    }
  }

  gitDirtyCache.set(moduleRoot, { ts: nowMs, dirty });
  return dirty;
}

export function clearGitDirtyCache() {
  gitDirtyCache.clear();
}

function readMtimeSecSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    const sec = st.mtimeMs / 1000;
    return Number.isFinite(sec) ? sec : null;
  } catch {
    return null;
  }
}

function defaultBrainRoots() {
  const home = homedir();
  return [
    join(home, '.gemini', 'antigravity', 'brain'),
    join(home, '.gemini', 'antigravity-ide', 'brain'),
  ];
}

function resolveTranscriptCandidates(lockItem, brainRoots) {
  const candidates = [];
  const rawTranscript = String(lockItem.ownerTranscriptPath ?? '').trim();
  if (rawTranscript) {
    candidates.push(rawTranscript);
    const logsDir = dirname(rawTranscript);
    const compact = join(logsDir, 'transcript.jsonl');
    if (compact !== rawTranscript) candidates.push(compact);
    return { transcripts: candidates, tasksDir: resolve(logsDir, '..', 'tasks') };
  }

  const ownerId = String(lockItem.ownerId ?? '').trim();
  if (ownerId && Array.isArray(brainRoots)) {
    for (const root of brainRoots) {
      if (!root) continue;
      const sysGen = join(root, ownerId, '.system_generated');
      if (existsSync(sysGen)) {
        return {
          transcripts: [
            join(sysGen, 'logs', 'transcript_full.jsonl'),
            join(sysGen, 'logs', 'transcript.jsonl'),
          ],
          tasksDir: join(sysGen, 'tasks'),
        };
      }
    }
  }
  return { transcripts: [], tasksDir: '' };
}

export function inspectOwnerActivity(
  lockItem,
  {
    now = Date.now() / 1000,
    suspectSeconds = STALL_SUSPECT_SECONDS,
    longSeconds = STALL_LONG_SECONDS,
    brainRoots = defaultBrainRoots(),
  } = {}
) {
  const baseActive = toNumber(lockItem.lastActiveAt, now);
  let latestActivityAt = baseActive;
  let activitySource = 'hook';

  const { transcripts, tasksDir } = resolveTranscriptCandidates(lockItem, brainRoots);
  for (const tp of transcripts) {
    const mtime = readMtimeSecSafe(tp);
    if (mtime !== null && mtime > latestActivityAt) {
      latestActivityAt = mtime;
      activitySource = 'transcript';
    }
  }

  if (tasksDir && existsSync(tasksDir)) {
    try {
      for (const ent of readdirSync(tasksDir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.log')) continue;
        const mtime = readMtimeSecSafe(join(tasksDir, ent.name));
        if (mtime !== null && mtime > latestActivityAt) {
          latestActivityAt = mtime;
          activitySource = 'task-log';
        }
      }
    } catch {
      // Ignore transient task log directory read errors.
    }
  }

  const activityIdleSeconds = Math.max(0, Math.floor(now - latestActivityAt));
  let healthState = 'active';
  if (lockItem.isReserved) {
    healthState = 'reserved';
  } else if (activityIdleSeconds >= longSeconds) {
    healthState = 'stale';
  } else if (activityIdleSeconds >= suspectSeconds) {
    healthState = 'stalled';
  }

  return {
    latestActivityAt,
    activityIdleSeconds,
    activitySource,
    healthState,
  };
}

export async function readDbSnapshot(
  db,
  {
    now = Date.now() / 1000,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    suspectSeconds = STALL_SUSPECT_SECONDS,
    longSeconds = STALL_LONG_SECONDS,
    eventLimit = EVENT_LIMIT,
    includeGitDirty = true,
    gitChecker,
    activityChecker,
    brainRoots = defaultBrainRoots(),
    summaryDbPaths = defaultSummaryDbPaths(),
  } = {}
) {
  const lockRows = db.prepare('SELECT * FROM locks ORDER BY module_key ASC').all();
  const queueRows = db
    .prepare("SELECT * FROM lock_queue WHERE status IN ('waiting', 'promoted') ORDER BY id ASC")
    .all();
  const eventRows = db
    .prepare('SELECT * FROM lock_events ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, eventLimit));
  const autoWakeEnabled = isAutoWakeEnabled(db);
  const guardSettings = readGuardSettings(db);

  const locks = lockRows.map((row) => mapLockRow(row, now, ttlSeconds));
  const lockByModule = new Map(locks.map((lk) => [lk.moduleKey, lk]));
  const ownerLockCounts = new Map();
  for (const lk of locks) {
    if (!lk.ownerId) continue;
    ownerLockCounts.set(lk.ownerId, (ownerLockCounts.get(lk.ownerId) ?? 0) + 1);
  }

  if (includeGitDirty && locks.length > 0) {
    const uniqueRoots = [...new Set(locks.map((lk) => lk.moduleRoot).filter(Boolean))];
    const rootResults = await Promise.all(
      uniqueRoots.map(async (root) => [
        root,
        await checkGitDirtyCached(root, { gitChecker }),
      ])
    );
    const dirtyByRoot = new Map(rootResults);
    for (const lk of locks) {
      lk.gitDirty = lk.moduleRoot ? (dirtyByRoot.get(lk.moduleRoot) ?? null) : null;
    }
  }

  const waitingRanks = new Map();
  const lockQueue = queueRows.map((row) => {
    const st = String(row.status ?? 'waiting');
    const mkey = String(row.module_key ?? '');
    let pos = 0;
    if (st === 'waiting') {
      pos = (waitingRanks.get(mkey) ?? 0) + 1;
      waitingRanks.set(mkey, pos);
    }
    const item = mapQueueRow(row, pos);
    if (st === 'promoted') {
      const held = lockByModule.get(mkey);
      if (held && held.ownerId === item.waiterConvId && held.reservedUntil !== null) {
        item.reservedUntil = held.reservedUntil;
        item.reservedRemainingSeconds = held.reservedRemainingSeconds;
      }
    }
    return item;
  });

  const lockEvents = eventRows.map(mapEventRow);
  const convIds = [
    ...locks.map((lk) => lk.ownerId),
    ...lockQueue.map((q) => q.waiterConvId),
    ...lockEvents.map((ev) => ev.convId),
  ];
  const summaries = readConversationSummaries(convIds, summaryDbPaths);

  const nextByModule = new Map();
  for (const q of lockQueue) {
    const isNextUp = q.status === 'promoted' || (q.status === 'waiting' && q.position === 1);
    const qSum = summaries.get(q.waiterConvId);
    q.waiterTitle = qSum?.title ?? '';
    q.waiterWorkspaceName = qSum?.workspaceName || basename(q.waiterWorkspace || '') || '';
    q.isNextUp = isNextUp;

    if (!isNextUp) continue;
    const existing = nextByModule.get(q.moduleKey);
    if (existing && existing.status === 'promoted') continue;
    nextByModule.set(q.moduleKey, {
      id: q.id,
      moduleKey: q.moduleKey,
      waiterConvId: q.waiterConvId,
      waiterTitle: q.waiterTitle,
      waiterWorkspaceName: q.waiterWorkspaceName,
      status: q.status,
      wakeStatus: q.wakeStatus,
      position: q.position,
      requestGroupId: q.requestGroupId,
      reservedRemainingSeconds: q.reservedRemainingSeconds,
      sessionKind: q.sessionKind,
    });
  }

  const waitingCountByModule = new Map();
  for (const q of lockQueue) {
    if (q.status === 'waiting' && q.moduleKey) {
      waitingCountByModule.set(
        q.moduleKey,
        (waitingCountByModule.get(q.moduleKey) ?? 0) + 1
      );
    }
  }

  let stalledCount = 0;
  let staleCount = 0;
  let blockingStalledCount = 0;

  for (const lk of locks) {
    const oSum = summaries.get(lk.ownerId);
    lk.ownerTitle = oSum?.title ?? '';
    lk.ownerWorkspaceName = oSum?.workspaceName || basename(lk.workspace || '') || '';
    lk.ownerLockCount = lk.ownerId ? (ownerLockCounts.get(lk.ownerId) ?? 1) : 0;
    lk.nextWaiter = nextByModule.get(lk.moduleKey) ?? null;

    const activity =
      typeof activityChecker === 'function'
        ? activityChecker(lk, { now, suspectSeconds, longSeconds })
        : inspectOwnerActivity(lk, { now, suspectSeconds, longSeconds, brainRoots });
    lk.latestActivityAt = activity.latestActivityAt;
    lk.activityIdleSeconds = activity.activityIdleSeconds;
    lk.activitySource = activity.activitySource;
    lk.healthState = activity.healthState;
    lk.waitingCount = waitingCountByModule.get(lk.moduleKey) ?? 0;
    const isStallLike = lk.healthState === 'stalled' || lk.healthState === 'stale';
    lk.isBlockingStalled = Boolean(lk.waitingCount > 0 && isStallLike);

    if (lk.healthState === 'stalled') stalledCount += 1;
    if (lk.healthState === 'stale') staleCount += 1;
    if (lk.isBlockingStalled) blockingStalledCount += 1;
  }

  for (const ev of lockEvents) {
    ev.convTitle = summaries.get(ev.convId)?.title ?? '';
  }

  return {
    now,
    autoWakeEnabled,
    guardSettings,
    stallSummary: {
      suspectSeconds,
      longSeconds,
      stalledCount,
      staleCount,
      blockingStalledCount,
    },
    locks,
    lock_queue: lockQueue,
    nextUp: [...nextByModule.values()],
    lock_events: lockEvents,
  };
}
