/**
 * Granular 4-tier `lock_claims` schema helper and active-claim snapshot reader.
 */

function toNum(val, fallback = 0) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function toOptNum(val) {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function parseStrList(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export function hasClaimsTable(db) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'lock_claims'")
    .get();
  return Boolean(row?.ok);
}

export function ensureClaimSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lock_claims (
      claim_id TEXT PRIMARY KEY,
      module_key TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      file_relpath TEXT NOT NULL DEFAULT '',
      lock_mode TEXT NOT NULL,
      tool_call_id TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      module_root TEXT NOT NULL,
      is_shared INTEGER NOT NULL DEFAULT 0,
      owner_project_id TEXT NOT NULL DEFAULT '',
      owner_transcript TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      child_ids_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      acquired_at REAL NOT NULL,
      last_active_at REAL NOT NULL,
      reserved_until REAL
    );
    CREATE INDEX IF NOT EXISTS idx_lock_claims_scope ON lock_claims(scope_key, lock_mode);
    CREATE INDEX IF NOT EXISTS idx_lock_claims_tool ON lock_claims(owner_id, tool_call_id);
  `);

  const cols = new Set(db.prepare('PRAGMA table_info(lock_queue)').all().map((c) => String(c.name ?? '')));
  if (!cols.has('scope_key')) {
    db.exec("ALTER TABLE lock_queue ADD COLUMN scope_key TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has('lock_mode')) {
    db.exec("ALTER TABLE lock_queue ADD COLUMN lock_mode TEXT NOT NULL DEFAULT 'BUILD_EXCL'");
  }
  if (!cols.has('file_relpath')) {
    db.exec("ALTER TABLE lock_queue ADD COLUMN file_relpath TEXT NOT NULL DEFAULT ''");
  }
}

export function cleanupExpiredClaimsTx(db, moduleKey, ownerId) {
  if (!hasClaimsTable(db)) return;
  db.prepare('DELETE FROM lock_claims WHERE module_key = ? AND owner_id = ?').run(moduleKey, ownerId);
}

function buildClaimTiming(lastActiveAt, reservedUntil, now, ttlSeconds) {
  const isReserved = reservedUntil !== null;
  const idleSeconds = Math.max(0, Math.floor(now - lastActiveAt));
  const reservedRemainingSeconds = isReserved ? Math.max(0, Math.ceil(reservedUntil - now)) : null;
  const ttlRemainingSeconds = isReserved
    ? reservedRemainingSeconds
    : Math.max(0, Math.ceil(ttlSeconds - (now - lastActiveAt)));
  const expired = isReserved ? now >= reservedUntil : now - lastActiveAt > ttlSeconds;
  return { isReserved, idleSeconds, reservedRemainingSeconds, ttlRemainingSeconds, expired };
}

export function readActiveClaims(
  db,
  { now = Date.now() / 1000, ttlSeconds = 1200, locks = [], summaryMap = new Map() } = {}
) {
  const legacyByModOwner = new Map();
  for (const lk of locks) {
    legacyByModOwner.set(`${lk.moduleKey}|${lk.ownerId}`, lk);
  }

  const out = [];
  const seenModOwner = new Set();

  if (hasClaimsTable(db)) {
    const rows = db.prepare('SELECT * FROM lock_claims ORDER BY acquired_at ASC, claim_id ASC').all();
    for (const row of rows) {
      const moduleKey = String(row.module_key ?? '');
      const ownerId = String(row.owner_id ?? '');
      seenModOwner.add(`${moduleKey}|${ownerId}`);
      const legacy = legacyByModOwner.get(`${moduleKey}|${ownerId}`);
      const acquiredAt = toNum(row.acquired_at, now);
      let lastActiveAt = toNum(row.last_active_at, acquiredAt);
      let reservedUntil = toOptNum(row.reserved_until);
      if (legacy) {
        if (legacy.lastActiveAt < lastActiveAt) lastActiveAt = legacy.lastActiveAt;
        if (legacy.reservedUntil !== null) reservedUntil = legacy.reservedUntil;
      }
      const timing = buildClaimTiming(lastActiveAt, reservedUntil, now, ttlSeconds);
      if (timing.expired) continue;
      const summary = summaryMap.get(ownerId) || {};
      out.push({
        claimId: String(row.claim_id ?? ''),
        moduleKey,
        scopeKey: String(row.scope_key ?? ''),
        fileRelpath: String(row.file_relpath ?? ''),
        lockMode: String(row.lock_mode || 'BUILD_EXCL'),
        toolCallId: String(row.tool_call_id ?? ''),
        ownerId,
        ownerTitle: summary.title || '',
        ownerWorkspaceName: summary.workspaceName || '',
        moduleRoot: String(row.module_root ?? ''),
        isShared: Boolean(row.is_shared),
        ownerProjectId: String(row.owner_project_id ?? ''),
        ownerTranscriptPath: String(row.owner_transcript ?? ''),
        workspace: String(row.workspace ?? ''),
        childIds: parseStrList(row.child_ids_json),
        tags: parseStrList(row.tags_json),
        acquiredAt,
        lastActiveAt,
        reservedUntil,
        ...timing,
      });
    }
  }

  for (const lk of locks) {
    if (seenModOwner.has(`${lk.moduleKey}|${lk.ownerId}`)) continue;
    const summary = summaryMap.get(lk.ownerId) || {};
    out.push({
      claimId: `legacy:${lk.moduleKey}:${lk.ownerId}`,
      moduleKey: lk.moduleKey,
      scopeKey: lk.moduleKey,
      fileRelpath: '',
      lockMode: 'BUILD_EXCL',
      toolCallId: '',
      ownerId: lk.ownerId,
      ownerTitle: lk.ownerTitle || summary.title || '',
      ownerWorkspaceName: lk.ownerWorkspaceName || summary.workspaceName || '',
      moduleRoot: lk.moduleRoot,
      isShared: Boolean(lk.isShared),
      ownerProjectId: lk.ownerProjectId || '',
      ownerTranscriptPath: lk.ownerTranscriptPath || '',
      workspace: lk.workspace || '',
      childIds: Array.isArray(lk.childIds) ? lk.childIds : [],
      tags: Array.isArray(lk.tags) ? lk.tags : [],
      acquiredAt: lk.acquiredAt,
      lastActiveAt: lk.lastActiveAt,
      reservedUntil: lk.reservedUntil,
      isReserved: Boolean(lk.isReserved),
      idleSeconds: lk.idleSeconds,
      reservedRemainingSeconds: lk.reservedRemainingSeconds,
      ttlRemainingSeconds: lk.ttlRemainingSeconds,
      expired: false,
    });
  }

  return out;
}
