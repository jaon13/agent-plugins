import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createContext, runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_MAX_LOCKS_PER_SESSION,
  DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS,
  cancelQueueEntryById,
  clearGitDirtyCache,
  inspectOwnerActivity,
  openLockDb,
  readDbSnapshot,
  setAutoWakeEnabled,
  sweepExpiredAndPromote,
} from '../lock_db.mjs';
import {
  createLockBoardController,
  createStandaloneHttpServer,
  createWatchdog,
  resolveProjectLockScript,
} from '../main.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOARD_DIR = resolve(__dirname, '..');

function makeTempDir(prefix = 'lock-board-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedBaseLockDb(dbPath, nowSec) {
  const repoDir = join(dirname(dbPath), 'mod-auto');
  mkdirSync(repoDir, { recursive: true });
  const db = openLockDb(dbPath);
  db.prepare(`
    INSERT INTO locks (
      module_key, module_root, is_shared, owner_id, owner_project_id,
      owner_transcript, workspace, child_ids_json, tags_json,
      acquired_at, last_active_at, reserved_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '02.Libraries/AutomationEngine',
    repoDir,
    1,
    'conv-owner-11111111',
    'proj-main',
    '',
    repoDir,
    JSON.stringify(['conv-child-1']),
    JSON.stringify(['edit']),
    nowSec - 120,
    nowSec - 15,
    null
  );

  db.prepare(`
    INSERT INTO lock_queue (
      request_group_id, module_key, waiter_conv_id, waiter_project_id,
      waiter_workspace, session_kind, reason_tag, status, retry_count,
      requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'grp_wait_1',
    '02.Libraries/AutomationEngine',
    'conv-waiter-22222222',
    'proj-wait-1',
    'D:\\Workspace\\02.Libraries\\AutomationEngine',
    'antigravity',
    'edit',
    'waiting',
    0,
    nowSec - 30,
    nowSec - 30
  );

  db.prepare(`
    INSERT INTO lock_queue (
      request_group_id, module_key, waiter_conv_id, waiter_project_id,
      waiter_workspace, session_kind, reason_tag, status, retry_count,
      requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'grp_wait_2',
    '02.Libraries/AutomationEngine',
    'conv-waiter-33333333',
    'proj-wait-2',
    'D:\\Workspace\\02.Libraries\\AutomationEngine',
    'antigravity',
    'build',
    'waiting',
    1,
    nowSec - 10,
    nowSec - 10
  );

  for (let i = 0; i < 45; i++) {
    db.prepare(
      'INSERT INTO lock_events (ts, event, module_key, conv_id, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(nowSec - (50 - i), 'ACQUIRED', '02.Libraries/AutomationEngine', 'conv-owner-11111111', `ev=${i}`);
  }

  db.close();
}

test('sidecar manifest, package.json, and static asset safety checks pass', async () => {
  const pkg = JSON.parse(readFileSync(join(BOARD_DIR, 'package.json'), 'utf-8'));
  assert.equal(pkg.type, 'module');

  const manifest = JSON.parse(readFileSync(join(BOARD_DIR, 'sidecar.json'), 'utf-8'));
  assert.equal(manifest.command, 'node');
  assert.deepEqual(manifest.args, ['main.mjs']);
  assert.equal(manifest.restart_policy, 'always');
  assert.equal(manifest.has_web_ui, true);
  assert.equal(manifest.display_name, 'Lock & Tooling');
  assert.equal(manifest.agent_permissions?.allows_user_interactions, false);
  assert.equal(
    manifest.ui_config?.views?.[0]?.entrypoint,
    'SIDECAR_UI_ENTRYPOINT_AUX_PANE'
  );

  const html = readFileSync(join(BOARD_DIR, 'index.html'), 'utf-8');
  assert.match(html, /<script src="\/preload\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.match(html, /id="tooling-execute-btn"/);
  assert.match(html, /id="tooling-clear-btn"/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style[\s>]/i);

  const css = readFileSync(join(BOARD_DIR, 'styles.css'), 'utf-8');
  assert.match(css, /^@layer\s+tokens,/);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /^\s*#[A-Za-z_-]/m);
  assert.match(css, /var\(--background/);
  assert.match(css, /var\(--foreground/);
  assert.match(css, /\.binary-card\.selected/);
  assert.match(css, /\.binary-checkbox/);

  const appJs = readFileSync(join(BOARD_DIR, 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(appJs, /window\.sidecar\?\.ui\?\.toggleConversation/);
  assert.match(appJs, /window\.sidecar\?\.agent\?\.sendMessage/);
  assert.match(appJs, /window\.sidecar\.getWorkspaceUris/);
  assert.match(appJs, /window\.sidecar\.onWorkspaceChange/);

  const jsFiles = [
    'main.mjs',
    'lock_db.mjs',
    'tooling_xray.mjs',
    'watchdog.mjs',
    'router.mjs',
    'app.js',
  ];
  for (const file of jsFiles) {
    await execFileAsync(process.execPath, ['--check', join(BOARD_DIR, file)]);
  }
});

test('readDbSnapshot returns WAL locks, FIFO queue ranks, and latest 40 events', async () => {
  const dir = makeTempDir();
  try {
    clearGitDirtyCache();
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_000_000;
    seedBaseLockDb(dbPath, nowSec);

    const db = openLockDb(dbPath);
    const modeRow = db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(modeRow.journal_mode).toLowerCase(), 'wal');

    const snap = await readDbSnapshot(db, {
      now: nowSec,
      includeGitDirty: true,
      gitChecker: async () => true,
    });
    db.close();

    assert.equal(snap.autoWakeEnabled, true);
    assert.equal(snap.locks.length, 1);
    assert.equal(snap.locks[0].moduleKey, '02.Libraries/AutomationEngine');
    assert.equal(snap.locks[0].gitDirty, true);
    assert.equal(snap.locks[0].idleSeconds, 15);
    assert.equal(snap.locks[0].ttlRemainingSeconds, 1185);
    assert.deepEqual(snap.locks[0].childIds, ['conv-child-1']);

    assert.equal(snap.lock_queue.length, 2);
    assert.equal(snap.lock_queue[0].position, 1);
    assert.equal(snap.lock_queue[0].waiterConvId, 'conv-waiter-22222222');
    assert.equal(snap.lock_queue[1].position, 2);
    assert.equal(snap.lock_queue[1].waiterConvId, 'conv-waiter-33333333');

    assert.equal(snap.lock_events.length, 40);
    assert.equal(snap.lock_events[0].detail, 'ev=44');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('2s watchdog sweeps expired reservation and promotes + wakes waiter #2', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_000_500;
    const db = openLockDb(dbPath);

    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES (?, ?, 0, ?, ?, '', ?, '[]', '["edit","reserved"]', ?, ?, ?)
    `).run(
      '03.Utilities/TaskBoard',
      'D:\\Workspace\\03.Utilities\\TaskBoard',
      'conv-waiter-1',
      'proj-1',
      'D:\\Workspace\\03.Utilities\\TaskBoard',
      nowSec - 65,
      nowSec - 65,
      nowSec - 5
    );

    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      'grp_1',
      '03.Utilities/TaskBoard',
      'conv-waiter-1',
      'proj-1',
      'D:\\Workspace\\03.Utilities\\TaskBoard',
      'antigravity',
      'edit',
      'promoted',
      nowSec - 70,
      nowSec - 65
    );

    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      'grp_2',
      '03.Utilities/TaskBoard',
      'conv-waiter-2',
      'proj-2',
      'D:\\Workspace\\03.Utilities\\TaskBoard',
      'antigravity',
      'edit',
      'waiting',
      nowSec - 50,
      nowSec - 50
    );
    db.close();

    const sentMessages = [];
    const mockApp = {
      async sendMessage(convId, msg, opts) {
        sentMessages.push({ convId, msg, opts });
        return { ok: true };
      },
    };

    const watchdog = createWatchdog({
      dbPath,
      app: mockApp,
      nowFn: () => nowSec,
    });
    const res = await watchdog.tick();

    assert.deepEqual(res.expiredKeys, ['03.Utilities/TaskBoard']);
    assert.equal(res.promotions.length, 1);
    assert.equal(res.promotions[0].waiterConvId, 'conv-waiter-2');
    assert.equal(res.wakeResults.length, 1);
    assert.equal(res.wakeResults[0].sent, true);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].convId, 'conv-waiter-2');
    assert.equal(sentMessages[0].opts.projectId, 'proj-2');
    assert.match(sentMessages[0].msg, /03\.Utilities\/TaskBoard/);

    const verifyDb = openLockDb(dbPath);
    const activeLock = verifyDb
      .prepare('SELECT * FROM locks WHERE module_key = ?')
      .get('03.Utilities/TaskBoard');
    assert.equal(activeLock.owner_id, 'conv-waiter-2');
    assert.equal(activeLock.reserved_until, nowSec + 60);

    const queueRows = verifyDb
      .prepare('SELECT waiter_conv_id, status FROM lock_queue ORDER BY id ASC')
      .all();
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].waiter_conv_id, 'conv-waiter-2');
    assert.equal(queueRows[0].status, 'promoted');

    const events = verifyDb
      .prepare('SELECT event, conv_id FROM lock_events ORDER BY id ASC')
      .all()
      .map((r) => `${r.event}:${r.conv_id}`);
    assert.ok(events.includes('RESERVATION_EXPIRED:conv-waiter-1'));
    assert.ok(events.includes('PROMOTED:conv-waiter-2'));
    assert.ok(events.includes('WAKE_SENT:conv-waiter-2'));
    verifyDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog respects auto_wake_enabled=0 and cursor session kind', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_001_000;
    const db = openLockDb(dbPath);
    setAutoWakeEnabled(db, false);

    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES ('mod/a', 'C:\\mod\\a', 0, 'owner-old', '', '', '', '[]', '["reserved"]', ?, ?, ?)
    `).run(nowSec - 70, nowSec - 70, nowSec - 1);

    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES ('grp_x', 'mod/a', 'waiter-paused', '', '', 'antigravity', 'edit', 'waiting', 0, ?, ?)
    `).run(nowSec - 40, nowSec - 40);
    db.close();

    let callCount = 0;
    const watchdog = createWatchdog({
      dbPath,
      app: {
        async sendMessage() {
          callCount += 1;
        },
      },
      nowFn: () => nowSec,
    });
    const res = await watchdog.tick();
    assert.equal(res.promotions.length, 1);
    assert.equal(res.wakeResults.length, 0);
    assert.equal(callCount, 0);

    // Now test cursor session with auto-wake enabled on another DB transaction.
    const db2 = openLockDb(dbPath);
    setAutoWakeEnabled(db2, true);
    db2.prepare('DELETE FROM locks').run();
    db2.prepare('DELETE FROM lock_queue').run();
    db2.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES ('mod/b', 'C:\\mod\\b', 0, 'owner-b', '', '', '', '[]', '["reserved"]', ?, ?, ?)
    `).run(nowSec - 70, nowSec - 70, nowSec - 1);
    db2.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES ('grp_c', 'mod/b', 'cursor-1', '', '', 'cursor', 'edit', 'waiting', 0, ?, ?)
    `).run(nowSec - 30, nowSec - 30);
    db2.close();

    const res2 = await watchdog.tick();
    assert.equal(res2.promotions.length, 1);
    assert.equal(res2.wakeResults[0].sent, false);
    assert.equal(callCount, 0);

    const db3 = openLockDb(dbPath);
    const failEv = db3
      .prepare("SELECT detail FROM lock_events WHERE event = 'WAKE_FAILED' AND conv_id = 'cursor-1'")
      .get();
    assert.match(String(failEv?.detail ?? ''), /cursor/);
    db3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP server serves static assets, /api/state (tooling + xray), /api/auto-wake, /api/queue/cancel, and /api/unlock', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_002_000;
    seedBaseLockDb(dbPath, nowSec);

    // Create mock tooling.json + binaries
    const binDir = join(dir, 'tooling', 'bin');
    mkdirSync(binDir, { recursive: true });
    const xrayExe = join(binDir, 'CodeXrayMcp.exe');
    const uiaExe = join(binDir, 'UiaMcp.exe');
    const grepExe = join(binDir, 'xray-grep.exe');
    writeFileSync(xrayExe, 'stub');
    writeFileSync(uiaExe, 'stub');
    writeFileSync(grepExe, 'stub');

    const toolingJsonPath = join(dir, 'tooling.json');
    writeFileSync(
      toolingJsonPath,
      JSON.stringify({
        agentToolingRoot: join(dir, 'tooling'),
        codeXrayRoot: join(dir, 'tooling'),
        codeXrayMcpExe: xrayExe,
        uiaMcpExe: uiaExe,
      })
    );

    // Create mock workspace .xray/index.db and .xray/reviews/grep_001.json
    const wsDir = join(dir, 'sample-ws');
    const reviewsDir = join(wsDir, '.xray', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    const indexDbPath = join(wsDir, '.xray', 'index.db');
    const idxDb = new DatabaseSync(indexDbPath);
    idxDb.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projects (name TEXT PRIMARY KEY);
      CREATE TABLE files (id INTEGER PRIMARY KEY);
      CREATE TABLE types (id INTEGER PRIMARY KEY);
      CREATE TABLE members (id INTEGER PRIMARY KEY);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('repo_root', '${wsDir.replace(/\\/g, '\\\\')}'), ('updated_epoch', '1760001900');
      INSERT INTO projects (name) VALUES ('App.Core'), ('App.UI');
      INSERT INTO files (id) VALUES (1), (2), (3);
      INSERT INTO types (id) VALUES (10), (11);
      INSERT INTO members (id) VALUES (100);
    `);
    idxDb.close();

    writeFileSync(
      join(reviewsDir, 'grep_20261119_abcd.json'),
      JSON.stringify({
        run_id: 'grep_20261119_abcd',
        pattern: 'HttpClient',
        is_regex: false,
        matches: [
          { file: 'src/Client.cs', line: 42, enclosing_symbol: 'Client::Send', status: 'pending' },
          { file: 'src/Auth.cs', line: 15, enclosing_symbol: 'Auth::Login', status: 'modify' },
        ],
      })
    );

    const unlockedCalls = [];
    const controller = createLockBoardController({
      dbPath,
      toolingJsonPath,
      includeGitDirty: false,
      nowFn: () => nowSec,
      unlockRunner: async ({ moduleKey, expiredOnly }) => {
        unlockedCalls.push({ moduleKey, expiredOnly });
        const db = openLockDb(dbPath);
        db.prepare('DELETE FROM locks WHERE module_key = ?').run(moduleKey);
        sweepExpiredAndPromote(db, { now: nowSec });
        db.close();
        return { stdout: `Unlocked 1 lock(s): ${moduleKey}`, stderr: '' };
      },
    });

    const server = createStandaloneHttpServer(controller);
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);

      const jsRes = await fetch(`${baseUrl}/app.js`);
      assert.equal(jsRes.status, 200);
      assert.match(jsRes.headers.get('content-type') || '', /javascript/);

      const cssRes = await fetch(`${baseUrl}/styles.css`);
      assert.equal(cssRes.status, 200);
      assert.match(cssRes.headers.get('content-type') || '', /text\/css/);

      const wsUri = pathToFileURL(wsDir).href;
      const stateRes = await fetch(
        `${baseUrl}/api/state?workspaces=${encodeURIComponent(JSON.stringify([wsUri]))}`
      );
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();

      assert.equal(state.locks.length, 1);
      assert.equal(state.lock_queue.length, 2);
      assert.equal(state.lock_events.length, 40);
      assert.equal(state.autoWakeEnabled, true);

      const xrayBin = state.tooling.binaries.find((b) => b.id === 'code-xray');
      const uiaBin = state.tooling.binaries.find((b) => b.id === 'uia-mcp');
      const grepBin = state.tooling.binaries.find((b) => b.id === 'xray-grep');
      const idxBin = state.tooling.binaries.find((b) => b.id === 'xray-index');
      assert.equal(xrayBin.exists, true);
      assert.equal(uiaBin.exists, true);
      assert.equal(grepBin.exists, true);
      assert.equal(idxBin.exists, false);
      assert.ok(String(xrayBin.summary || '').length > 5);
      assert.ok(String(xrayBin.description || '').length > 10);
      assert.equal(xrayBin.category, 'MCP Server');
      assert.equal(Array.isArray(state.tooling.rootInfo), true);
      assert.equal(state.tooling.rootInfo.length, 2);
      assert.ok(String(state.tooling.rootInfo[0].summary || '').length > 5);

      assert.equal(state.xray.workspaces.length, 1);
      assert.equal(state.xray.workspaces[0].indexDb.exists, true);
      assert.deepEqual(state.xray.workspaces[0].indexDb.counts, {
        projects: 2,
        files: 3,
        types: 2,
        members: 1,
      });
      assert.equal(state.xray.workspaces[0].reviews.length, 1);
      assert.equal(state.xray.workspaces[0].reviews[0].pattern, 'HttpClient');
      assert.equal(state.xray.workspaces[0].reviews[0].totalMatches, 2);
      assert.equal(state.xray.workspaces[0].reviews[0].fileCount, 2);
      assert.deepEqual(state.xray.workspaces[0].reviews[0].statusCounts, {
        pending: 1,
        modify: 1,
      });

      // Toggle auto-wake off
      const wakeOffRes = await fetch(`${baseUrl}/api/auto-wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(wakeOffRes.status, 200);
      const wakeOff = await wakeOffRes.json();
      assert.equal(wakeOff.autoWakeEnabled, false);
      assert.equal(wakeOff.value, '0');

      // Cancel queue entry #2
      const secondQueueId = state.lock_queue[1].id;
      const cancelRes = await fetch(`${baseUrl}/api/queue/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: secondQueueId }),
      });
      assert.equal(cancelRes.status, 200);
      const cancelled = await cancelRes.json();
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.cancelled, 1);
      assert.equal(cancelled.state.lock_queue.length, 1);

      // Missing queue entry returns 404
      const missingRes = await fetch(`${baseUrl}/api/queue/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 999999 }),
      });
      assert.equal(missingRes.status, 404);

      // Manual unlock via POST /api/unlock
      const unlockRes = await fetch(`${baseUrl}/api/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleKey: '02.Libraries/AutomationEngine' }),
      });
      assert.equal(unlockRes.status, 200);
      const unlocked = await unlockRes.json();
      assert.equal(unlocked.ok, true);
      assert.equal(unlockedCalls.length, 1);
      assert.equal(unlockedCalls[0].moduleKey, '02.Libraries/AutomationEngine');
      assert.equal(unlocked.state.locks.length, 0);

      // Clean direct helper test
      const dbCheck = openLockDb(dbPath);
      const invalidCancel = cancelQueueEntryById(dbCheck, -5);
      assert.equal(invalidCancel.status, 400);
      dbCheck.close();
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/unlock integrates end-to-end with real project_lock.py CLI', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = Date.now() / 1000;
    const db = openLockDb(dbPath);
    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES ('03.Utilities/TestMod', ?, 0, 'conv-cli-owner', '', '', '', '[]', '["edit"]', ?, ?, NULL)
    `).run(join(dir, 'TestMod'), nowSec - 10, nowSec - 10);
    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES ('grp_cli', '03.Utilities/TestMod', 'conv-cli-waiter', '', '', 'external', 'edit', 'waiting', 0, ?, ?)
    `).run(nowSec - 5, nowSec - 5);
    db.close();

    const controller = createLockBoardController({
      dbPath,
      includeGitDirty: false,
      env: { ...process.env, PROJECT_LOCK_DIR: dir },
    });

    const resp = await controller.handlePostUnlock({ moduleKey: '03.Utilities/TestMod' });
    assert.equal(resp.status, 200);
    assert.equal(resp.json.ok, true);
    assert.match(resp.json.output, /Unlocked 1 lock\(s\): 03\.Utilities\/TestMod/);
    assert.match(resp.json.output, /Promoted waiter conv-cli/);

    // Verify lock is now reserved for waiter
    assert.equal(resp.json.state.locks.length, 1);
    assert.equal(resp.json.state.locks[0].ownerId, 'conv-cli-waiter');
    assert.equal(resp.json.state.locks[0].isReserved, true);
    assert.equal(resolveProjectLockScript().endsWith('project_lock.py'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog skips blocked multi-module request_group_id and promotes unblocked waiter', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_003_000;
    const db = openLockDb(dbPath);

    // mod/x reservation expired; mod/y still held by owner-y
    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES
      ('mod/x', 'C:\\mod\\x', 0, 'expired-x', '', '', '', '[]', '["reserved"]', ?, ?, ?),
      ('mod/y', 'C:\\mod\\y', 0, 'owner-y', '', '', '', '[]', '["edit"]', ?, ?, NULL)
    `).run(nowSec - 70, nowSec - 70, nowSec - 2, nowSec - 20, nowSec - 20);

    // Waiter #1 needs BOTH mod/x and mod/y (blocked because owner-y holds mod/y)
    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES
      ('grp_both', 'mod/x', 'waiter-both', '', '', 'antigravity', 'build', 'waiting', 0, ?, ?),
      ('grp_both', 'mod/y', 'waiter-both', '', '', 'antigravity', 'build', 'waiting', 0, ?, ?),
      ('grp_x_only', 'mod/x', 'waiter-x-only', 'proj-x', '', 'antigravity', 'edit', 'waiting', 0, ?, ?)
    `).run(nowSec - 40, nowSec - 40, nowSec - 40, nowSec - 40, nowSec - 30, nowSec - 30);
    db.close();

    const sent = [];
    const watchdog = createWatchdog({
      dbPath,
      app: {
        async sendMessage(convId, msg, opts) {
          sent.push({ convId, msg, opts });
        },
      },
      nowFn: () => nowSec,
    });
    const res = await watchdog.tick();
    assert.deepEqual(res.expiredKeys, ['mod/x']);
    assert.equal(res.promotions.length, 1);
    assert.equal(res.promotions[0].waiterConvId, 'waiter-x-only');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].convId, 'waiter-x-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main.mjs runs inside real Antigravity sidecar_sdk loader when register_loader.js is present', async (t) => {
  const loaderPath = 'C:\\Users\\User\\.gemini\\antigravity\\lib\\node_modules\\sidecar_sdk\\register_loader.js';
  const fsMod = await import('node:fs');
  if (!fsMod.existsSync(loaderPath)) {
    t.skip('sidecar_sdk register_loader.js not present on this host');
    return;
  }

  const dir = makeTempDir();
  const { spawn } = await import('node:child_process');
  try {
    const token = 'test-sidecar-token-123';
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(loaderPath).href, join(BOARD_DIR, 'main.mjs')],
      {
        cwd: BOARD_DIR,
        env: {
          ...process.env,
          PROJECT_LOCK_DIR: dir,
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
          ANTIGRAVITY_CSRF_TOKEN: token,
          ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
          ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    const port = await new Promise((resolvePort, rejectPort) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      const timer = setTimeout(() => {
        rejectPort(new Error(`Timeout waiting for sidecar listen. stdout=${stdoutBuf} stderr=${stderrBuf}`));
      }, 5000);
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const m = stdoutBuf.match(/listening on 127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolvePort(Number(m[1]));
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        rejectPort(new Error(`Sidecar exited early with code ${code}: ${stderrBuf}`));
      });
    });

    try {
      const preloadRes = await fetch(`http://127.0.0.1:${port}/preload.js`);
      assert.equal(preloadRes.status, 200);
      const pageRes = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(pageRes.status, 200);

      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      assert.equal(state.autoWakeEnabled, true);

      // Token-protected POST route
      const unauthRes = await fetch(`http://127.0.0.1:${port}/api/auto-wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(unauthRes.status, 401);

      const authRes = await fetch(`http://127.0.0.1:${port}/api/auto-wake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': token,
        },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(authRes.status, 200);
      const toggled = await authRes.json();
      assert.equal(toggled.autoWakeEnabled, false);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog picks up hook-deferred promoted wake_status=pending without expired locks and prevents duplicate wakes', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_002_000;
    const db = openLockDb(dbPath);

    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES (?, ?, 1, ?, ?, '', ?, '[]', '["edit","reserved"]', ?, ?, ?)
    `).run(
      '00.SharedCore/Shared.UI',
      'D:\\Workspace\\00.SharedCore\\src\\Shared.UI',
      'conv-deferred-waiter',
      'proj-waiter',
      'D:\\Workspace\\00.SharedCore',
      nowSec - 2,
      nowSec - 2,
      nowSec + 58
    );

    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, wake_status,
        retry_count, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'promoted', 'pending', 0, ?, ?)
    `).run(
      'grp_deferred_1',
      '00.SharedCore/Shared.UI',
      'conv-deferred-waiter',
      'proj-waiter',
      'D:\\Workspace\\00.SharedCore',
      'antigravity',
      'edit',
      nowSec - 20,
      nowSec - 2
    );
    db.close();

    const sentMessages = [];
    const mockApp = {
      async sendMessage(convId, msg, opts) {
        sentMessages.push({ convId, msg, opts });
        return { ok: true };
      },
    };

    const watchdog = createWatchdog({
      dbPath,
      app: mockApp,
      nowFn: () => nowSec,
    });

    const first = await watchdog.tick();
    assert.deepEqual(first.expiredKeys, []);
    assert.equal(first.promotions.length, 1);
    assert.equal(first.wakeResults.length, 1);
    assert.equal(first.wakeResults[0].sent, true);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].convId, 'conv-deferred-waiter');

    // Second tick must not send duplicate wake message.
    const second = await watchdog.tick();
    assert.equal(second.promotions.length, 0);
    assert.equal(sentMessages.length, 1);

    const verifyDb = openLockDb(dbPath);
    const qRow = verifyDb
      .prepare('SELECT wake_status FROM lock_queue WHERE request_group_id = ?')
      .get('grp_deferred_1');
    assert.equal(qRow.wake_status, 'sent');
    verifyDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDbSnapshot resolves conversation_summaries.db titles, nextWaiter, nextUp, and POST /api/wake', async () => {
  const dir = makeTempDir();
  try {
    clearGitDirtyCache();
    const dbPath = join(dir, 'locks.db');
    const summaryPath = join(dir, 'conversation_summaries.db');
    const nowSec = 1_760_003_000;

    const sdb = new DatabaseSync(summaryPath);
    sdb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT
      );
    `);
    sdb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
      'conv-owner-11111111',
      'Lock Owner Work',
      '["file:///D:/Workspace/02.Libraries"]'
    );
    sdb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
      'conv-waiter-22222222',
      'Queued Next Work',
      '["file:///D:/Workspace/02.Libraries"]'
    );
    sdb.close();

    seedBaseLockDb(dbPath, nowSec);

    const db = openLockDb(dbPath);
    const snap = await readDbSnapshot(db, {
      now: nowSec,
      includeGitDirty: false,
      summaryDbPaths: [summaryPath],
    });
    assert.equal(snap.locks[0].ownerTitle, 'Lock Owner Work');
    assert.equal(snap.locks[0].nextWaiter?.waiterConvId, 'conv-waiter-22222222');
    assert.equal(snap.locks[0].nextWaiter?.waiterTitle, 'Queued Next Work');
    assert.equal(snap.lock_queue[0].waiterTitle, 'Queued Next Work');
    assert.equal(snap.lock_queue[0].isNextUp, true);
    assert.equal(snap.lock_queue[1].isNextUp, false);
    assert.equal(snap.nextUp.length, 1);
    assert.equal(snap.nextUp[0].waiterTitle, 'Queued Next Work');
    assert.equal(snap.lock_events[0].convTitle, 'Lock Owner Work');

    // Promote waiter #1 manually via sweep or SQL so we can exercise POST /api/wake
    db.prepare('DELETE FROM locks WHERE module_key = ?').run('02.Libraries/AutomationEngine');
    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES (?, ?, 1, ?, ?, '', ?, '[]', '["edit","reserved"]', ?, ?, ?)
    `).run(
      '02.Libraries/AutomationEngine',
      'D:\\Workspace\\02.Libraries\\AutomationEngine',
      'conv-waiter-22222222',
      'proj-2',
      'D:\\Workspace\\02.Libraries\\AutomationEngine',
      nowSec,
      nowSec,
      nowSec + 10
    );
    db.prepare(
      "UPDATE lock_queue SET status = 'promoted', wake_status = 'failed' WHERE waiter_conv_id = ?"
    ).run('conv-waiter-22222222');
    const rows = db
      .prepare('SELECT id, status FROM lock_queue ORDER BY id ASC')
      .all();
    db.close();

    const promotedId = rows.find((r) => r.status === 'promoted').id;
    const waitingId = rows.find((r) => r.status === 'waiting').id;

    const sent = [];
    const controller = createLockBoardController({
      dbPath,
      summaryDbPaths: [summaryPath],
      includeGitDirty: false,
      nowFn: () => nowSec,
      app: {
        async sendMessage(convId, msg, opts) {
          sent.push({ convId, msg, opts });
        },
      },
    });

    const server = createStandaloneHttpServer(controller);
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = server.address().port;
      const waitRes = await fetch(`http://127.0.0.1:${port}/api/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: waitingId }),
      });
      assert.equal(waitRes.status, 409);

      const wakeRes = await fetch(`http://127.0.0.1:${port}/api/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: promotedId }),
      });
      assert.equal(wakeRes.status, 200);
      const wakeJson = await wakeRes.json();
      assert.equal(wakeJson.sent, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].convId, 'conv-waiter-22222222');
      assert.equal(wakeJson.state.nextUp[0].wakeStatus, 'sent');
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectOwnerActivity and readDbSnapshot classify active task-log vs stalled/stale blocking locks', async () => {
  const dir = makeTempDir();
  try {
    clearGitDirtyCache();
    const dbPath = join(dir, 'locks.db');
    const nowSec = Math.floor(Date.now() / 1000);

    // Build synthetic session log + task log directories for owner-active
    const logsDir = join(dir, 'brain-active', '.system_generated', 'logs');
    const tasksDir = join(dir, 'brain-active', '.system_generated', 'tasks');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
    const activeTranscript = join(logsDir, 'transcript_full.jsonl');
    const activeTaskLog = join(tasksDir, 'task-1.log');
    writeFileSync(activeTranscript, '{}\n');
    writeFileSync(activeTaskLog, 'building...\n');
    utimesSync(activeTranscript, nowSec - 240, nowSec - 240);
    utimesSync(activeTaskLog, nowSec - 12, nowSec - 12);

    // Stalled owner with old transcript and no task logs
    const stalledLogsDir = join(dir, 'brain-stalled', '.system_generated', 'logs');
    mkdirSync(stalledLogsDir, { recursive: true });
    const stalledTranscript = join(stalledLogsDir, 'transcript_full.jsonl');
    writeFileSync(stalledTranscript, '{}\n');
    utimesSync(stalledTranscript, nowSec - 260, nowSec - 260);

    const db = openLockDb(dbPath);
    db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES
      ('00.SharedCore/Shared.Core', 'C:\\mod\\core', 1, 'owner-active', '', ?, '', '[]', '["build"]', ?, ?, NULL),
      ('02.Libraries/AutomationEngine', 'C:\\mod\\rpa', 1, 'owner-stalled', '', ?, '', '[]', '["edit"]', ?, ?, NULL),
      ('03.Utilities/OldApp', 'C:\\mod\\old', 0, 'owner-stale', '', '', '', '[]', '["edit"]', ?, ?, NULL),
      ('05.Tooling/01.CodeXray', 'C:\\mod\\cx', 0, 'owner-reserved', '', '', '', '[]', '["reserved"]', ?, ?, ?)
    `).run(
      activeTranscript,
      nowSec - 300,
      nowSec - 260,
      stalledTranscript,
      nowSec - 400,
      nowSec - 260,
      nowSec - 700,
      nowSec - 650,
      nowSec - 10,
      nowSec - 10,
      nowSec + 50
    );

    // Add queued waiter on stalled AutomationEngine lock
    db.prepare(`
      INSERT INTO lock_queue (
        request_group_id, module_key, waiter_conv_id, waiter_project_id,
        waiter_workspace, session_kind, reason_tag, status, retry_count,
        requested_at, updated_at
      ) VALUES ('grp_wait_auto', '02.Libraries/AutomationEngine', 'waiter-1', '', '', 'antigravity', 'edit', 'waiting', 0, ?, ?)
    `).run(nowSec - 120, nowSec - 120);

    const snap = await readDbSnapshot(db, {
      now: nowSec,
      includeGitDirty: false,
      brainRoots: [],
      summaryDbPaths: [],
    });
    db.close();

    const byKey = new Map(snap.locks.map((lk) => [lk.moduleKey, lk]));
    const core = byKey.get('00.SharedCore/Shared.Core');
    const autoMod = byKey.get('02.Libraries/AutomationEngine');
    const old = byKey.get('03.Utilities/OldApp');
    const cx = byKey.get('05.Tooling/01.CodeXray');

    assert.equal(core.healthState, 'active');
    assert.equal(core.activitySource, 'task-log');
    assert.equal(core.isBlockingStalled, false);

    assert.equal(autoMod.healthState, 'stalled');
    assert.equal(autoMod.waitingCount, 1);
    assert.equal(autoMod.isBlockingStalled, true);

    assert.equal(old.healthState, 'stale');
    assert.equal(old.isBlockingStalled, false);

    assert.equal(cx.healthState, 'reserved');
    assert.equal(cx.isBlockingStalled, false);

    assert.deepEqual(snap.stallSummary, {
      suspectSeconds: 180,
      longSeconds: 600,
      stalledCount: 1,
      staleCount: 1,
      blockingStalledCount: 1,
    });

    // Direct helper test on transcript fallback when task log is older than transcript
    utimesSync(activeTaskLog, nowSec - 300, nowSec - 300);
    utimesSync(activeTranscript, nowSec - 20, nowSec - 20);
    const directAct = inspectOwnerActivity(core, { now: nowSec, brainRoots: [] });
    assert.equal(directAct.healthState, 'active');
    assert.equal(directAct.activitySource, 'transcript');

    const html = readFileSync(join(BOARD_DIR, 'index.html'), 'utf-8');
    const appJs = readFileSync(join(BOARD_DIR, 'app.js'), 'utf-8');
    assert.ok(html.includes('id="stall-alert-banner"'));
    assert.ok(appJs.includes('makeTooltipText'));
    assert.ok(appJs.includes('makeHealthBadge'));
    assert.ok(!appJs.includes('innerHTML'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDbSnapshot and /api/state expose guardSettings, ownerLockCount, and LIMIT_DENIED/DEP_GUARD_DENIED events', async () => {
  assert.equal(DEFAULT_MAX_LOCKS_PER_SESSION, 4);
  assert.equal(DEFAULT_MAX_SHARED_DEPS_WITHOUT_NODEPS, 3);

  const dir = makeTempDir();
  try {
    clearGitDirtyCache();
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_004_000;

    // Empty DB fallback via /api/state before locks.db is created
    const emptyController = createLockBoardController({
      dbPath,
      includeGitDirty: false,
      nowFn: () => nowSec,
    });
    const emptyServer = createStandaloneHttpServer(emptyController);
    await new Promise((resolveListen) => emptyServer.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = emptyServer.address().port;
      const emptyStateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(emptyStateRes.status, 200);
      const emptyState = await emptyStateRes.json();
      assert.equal(emptyState.dbExists, false);
      assert.deepEqual(emptyState.guardSettings, {
        maxLocksPerSession: 4,
        maxSharedDepsWithoutNodeps: 3,
      });
    } finally {
      await new Promise((resolveClose) => emptyServer.close(resolveClose));
    }

    const db = openLockDb(dbPath);
    const defaultSnap = await readDbSnapshot(db, {
      now: nowSec,
      includeGitDirty: false,
      summaryDbPaths: [],
    });
    assert.deepEqual(defaultSnap.guardSettings, {
      maxLocksPerSession: 4,
      maxSharedDepsWithoutNodeps: 3,
    });

    // Invalid/non-positive values in lock_settings safely fall back to defaults
    db.prepare("INSERT OR REPLACE INTO lock_settings (key, value) VALUES ('max_locks_per_session', '0')").run();
    db.prepare(
      "INSERT OR REPLACE INTO lock_settings (key, value) VALUES ('max_shared_deps_without_nodeps', 'invalid')"
    ).run();
    const fallbackSnap = await readDbSnapshot(db, {
      now: nowSec,
      includeGitDirty: false,
      summaryDbPaths: [],
    });
    assert.deepEqual(fallbackSnap.guardSettings, {
      maxLocksPerSession: 4,
      maxSharedDepsWithoutNodeps: 3,
    });

    // Valid lock_settings overrides + active locks for two owners + guard events
    db.prepare("INSERT OR REPLACE INTO lock_settings (key, value) VALUES ('max_locks_per_session', '6')").run();
    db.prepare(
      "INSERT OR REPLACE INTO lock_settings (key, value) VALUES ('max_shared_deps_without_nodeps', '2')"
    ).run();

    const insertLock = db.prepare(`
      INSERT INTO locks (
        module_key, module_root, is_shared, owner_id, owner_project_id,
        owner_transcript, workspace, child_ids_json, tags_json,
        acquired_at, last_active_at, reserved_until
      ) VALUES (?, ?, 1, ?, '', '', '', '[]', '["build"]', ?, ?, NULL)
    `);
    for (const mod of ['00.SharedCore/ModA', '00.SharedCore/ModB', '00.SharedCore/ModC', '00.SharedCore/ModD']) {
      insertLock.run(mod, `C:\\mod\\${mod}`, 'owner-four', nowSec - 10, nowSec - 10);
    }
    for (const mod of ['02.Libraries/LibX', '02.Libraries/LibY']) {
      insertLock.run(mod, `C:\\mod\\${mod}`, 'owner-two', nowSec - 5, nowSec - 5);
    }

    db.prepare(
      'INSERT INTO lock_events (ts, event, module_key, conv_id, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(nowSec - 2, 'LIMIT_DENIED', '00.SharedCore/ModE', 'owner-four', 'held=4;projected=5;limit=4');
    db.prepare(
      'INSERT INTO lock_events (ts, event, module_key, conv_id, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(
      nowSec - 1,
      'DEP_GUARD_DENIED',
      '00.SharedCore/ModA,00.SharedCore/ModB,00.SharedCore/ModC',
      'owner-two',
      'shared=3;limit=3'
    );

    const snap = await readDbSnapshot(db, {
      now: nowSec,
      includeGitDirty: false,
      summaryDbPaths: [],
    });
    db.close();

    assert.deepEqual(snap.guardSettings, {
      maxLocksPerSession: 6,
      maxSharedDepsWithoutNodeps: 2,
    });
    const byModule = new Map(snap.locks.map((lk) => [lk.moduleKey, lk]));
    assert.equal(byModule.get('00.SharedCore/ModA').ownerLockCount, 4);
    assert.equal(byModule.get('00.SharedCore/ModD').ownerLockCount, 4);
    assert.equal(byModule.get('02.Libraries/LibX').ownerLockCount, 2);
    assert.equal(byModule.get('02.Libraries/LibY').ownerLockCount, 2);

    const snapEvents = new Map(snap.lock_events.map((ev) => [ev.event, ev]));
    assert.equal(snapEvents.get('LIMIT_DENIED')?.moduleKey, '00.SharedCore/ModE');
    assert.equal(snapEvents.get('LIMIT_DENIED')?.detail, 'held=4;projected=5;limit=4');
    assert.equal(
      snapEvents.get('DEP_GUARD_DENIED')?.moduleKey,
      '00.SharedCore/ModA,00.SharedCore/ModB,00.SharedCore/ModC'
    );

    const controller = createLockBoardController({
      dbPath,
      includeGitDirty: false,
      nowFn: () => nowSec,
      summaryDbPaths: [],
    });
    const server = createStandaloneHttpServer(controller);
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      assert.equal(res.status, 200);
      const state = await res.json();
      assert.deepEqual(state.guardSettings, {
        maxLocksPerSession: 6,
        maxSharedDepsWithoutNodeps: 2,
      });
      const apiByMod = new Map(state.locks.map((lk) => [lk.moduleKey, lk]));
      assert.equal(apiByMod.get('00.SharedCore/ModA').ownerLockCount, 4);
      assert.equal(apiByMod.get('02.Libraries/LibX').ownerLockCount, 2);

      const apiEvents = new Map(state.lock_events.map((ev) => [ev.event, ev]));
      assert.ok(apiEvents.has('LIMIT_DENIED'));
      assert.ok(apiEvents.has('DEP_GUARD_DENIED'));
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }

    const appJs = readFileSync(join(BOARD_DIR, 'app.js'), 'utf-8');
    const stylesCss = readFileSync(join(BOARD_DIR, 'styles.css'), 'utf-8');
    assert.doesNotMatch(appJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.ok(appJs.includes('ownerLockCount'));
    assert.ok(appJs.includes('guardSettings'));
    assert.ok(appJs.includes('LIMIT_DENIED'));
    assert.ok(appJs.includes('DEP_GUARD_DENIED'));
    assert.ok(appJs.includes('세션 락 상한 초과 차단'));
    assert.ok(appJs.includes('연쇄 공유 모듈 빌드 차단 (--no-dependencies 필요)'));
    assert.ok(appJs.includes('badge-warning'));
    assert.ok(stylesCss.includes('.quota-badge'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Tooling tab multi-select checkboxes survive refresh and Execute sends combined prompt via sidecar.agent.sendMessage', async () => {
  class FakeClassList {
    constructor(owner) {
      this.owner = owner;
      this.set = new Set();
    }
    syncFromString(str) {
      this.set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    add(...cls) {
      for (const c of cls) this.set.add(c);
    }
    remove(...cls) {
      for (const c of cls) this.set.delete(c);
    }
    toggle(c, force) {
      if (force === undefined) {
        if (this.set.has(c)) this.set.delete(c);
        else this.set.add(c);
        return this.set.has(c);
      }
      if (force) this.set.add(c);
      else this.set.delete(c);
      return Boolean(force);
    }
    contains(c) {
      return this.set.has(c);
    }
  }

  class FakeElement {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.attributes = {};
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.classList = new FakeClassList(this);
      this._className = '';
      this._textContent = '';
      this.checked = false;
      this.disabled = false;
      this.value = '';
      this.hidden = false;
    }
    get className() {
      return [...this.classList.set].join(' ');
    }
    set className(val) {
      this._className = String(val || '');
      this.classList.syncFromString(this._className);
    }
    get firstChild() {
      return this.children[0] || null;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    }
    append(...nodes) {
      for (const n of nodes) {
        this.children.push(typeof n === 'string' ? { nodeType: 3, textContent: n } : n);
      }
    }
    appendChild(node) {
      this.append(node);
      return node;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    }
    getAttribute(k) {
      return this.attributes[k] ?? null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    async dispatch(type, extra = {}) {
      const list = this.listeners.get(type) || [];
      for (const fn of list) {
        await fn({ target: this, preventDefault() {}, ...extra });
      }
    }
    get textContent() {
      return this._textContent;
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
    }
    get text() {
      return this._textContent;
    }
    focus() {}
  }

  const byId = new Map();
  const reg = (tag, id, extra = {}) => {
    const node = new FakeElement(tag, id);
    Object.assign(node, extra);
    byId.set(id, node);
    return node;
  };
  const tabs = [
    reg('button', 'tabbtn-locks', { dataset: { tab: 'locks' } }),
    reg('button', 'tabbtn-tooling', { dataset: { tab: 'tooling' } }),
  ];
  for (const id of [
    'toast', 'tab-locks', 'tab-tooling', 'lock-filter', 'auto-wake-toggle', 'refresh-btn',
    'live-status', 'live-label', 'stat-locks', 'stat-queue', 'stat-next', 'stat-next-pill',
    'stat-wake', 'stat-ws', 'stat-ws-pill', 'tab-count-locks', 'tab-count-tooling',
    'stall-alert-banner', 'next-up-section', 'next-up-count', 'next-up-list',
    'locks-count', 'locks-tbody', 'locks-table-wrap', 'locks-empty',
    'queue-count', 'queue-tbody', 'queue-table-wrap', 'queue-empty',
    'recent-wakes-count', 'recent-wakes-list', 'tooling-json-status', 'tooling-roots',
    'tooling-selection-summary', 'tooling-clear-btn', 'tooling-execute-btn', 'tooling-binaries',
    'xray-ws-count', 'xray-workspaces', 'reviews-count', 'xray-reviews', 'events-count', 'events-list',
  ]) {
    reg('div', id);
  }
  byId.get('tooling-clear-btn').disabled = true;
  byId.get('tooling-execute-btn').disabled = true;

  const sampleState = {
    locks: [],
    lock_queue: [],
    nextUp: [],
    lock_events: [],
    autoWakeEnabled: true,
    guardSettings: { maxLocksPerSession: 4, maxSharedDepsWithoutNodeps: 3 },
    tooling: {
      toolingJsonExists: true,
      toolingJsonPath: 'C:\\tmp\\tooling.json',
      rootInfo: [],
      binaries: [
        {
          id: 'code-xray',
          label: 'CodeXrayMcp',
          category: 'MCP Server',
          summary: 'Multi-language MCP',
          description: 'MCP server',
          actionHint: 'Run code-xray MCP analysis.',
          exists: true,
          sizeBytes: 1024,
        },
        {
          id: 'structural-clone',
          label: 'structural-clone',
          category: 'CLI Analyzer',
          summary: 'Clone detector',
          description: 'AST clone scanner',
          actionHint: 'Run structural-clone scan.',
          exists: true,
          sizeBytes: 2048,
        },
      ],
    },
    xray: {
      activeWorkspaces: ['D:\\Workspace\\DemoRepo'],
      workspaces: [],
    },
  };

  const sentMessages = [];
  const fakeDoc = {
    hidden: false,
    documentElement: new FakeElement('html'),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) }),
    querySelectorAll: (sel) => (sel === '.tab' ? tabs : []),
    addEventListener: () => {},
  };
  const fakeWindow = {
    sidecar: {
      conversationId: 'conv-active-1',
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(sampleState),
      }),
      onWorkspaceChange: () => () => {},
      getWorkspaceUris: async () => ['file:///D:/Workspace/DemoRepo'],
      agent: {
        sendMessage: async (message) => {
          sentMessages.push(message);
          return { ok: true };
        },
      },
      ui: { toggleConversation: () => {} },
    },
  };

  const timers = [];
  const ctx = createContext({
    Node: FakeElement,
    document: fakeDoc,
    window: fakeWindow,
    navigator: {},
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 20)' }),
    MutationObserver: class { observe() {} },
    setTimeout: (fn) => {
      const id = timers.length + 1;
      timers.push(fn);
      return id;
    },
    clearTimeout: () => {},
    setInterval: () => 999,
    clearInterval: () => {},
    URLSearchParams,
    console,
  });

  const appSource = readFileSync(join(BOARD_DIR, 'app.js'), 'utf-8');
  runInNewContext(appSource, ctx);
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  };
  await flush();
  assert.equal(byId.get('toast').classList.contains('error'), false, byId.get('toast').textContent);

  const collectCheckboxes = () => {
    const cards = byId.get('tooling-binaries').children;
    const boxes = [];
    for (const card of cards) {
      const head = card.children[0];
      const titleWrap = head.children[0];
      const cb = titleWrap.children[0];
      boxes.push({ card, cb, id: card.dataset.toolId });
    }
    return boxes;
  };

  let boxes = collectCheckboxes();
  assert.equal(boxes.length, 2);
  assert.equal(byId.get('tooling-execute-btn').disabled, true);

  // Select both tools
  boxes[0].cb.checked = true;
  await boxes[0].cb.dispatch('change');
  boxes[1].cb.checked = true;
  await boxes[1].cb.dispatch('change');
  assert.equal(byId.get('tooling-execute-btn').disabled, false);
  assert.equal(byId.get('tooling-execute-btn').textContent, 'Execute (2)');

  // Simulate poll refresh (Click Refresh button) and verify both checkboxes stay checked
  await byId.get('refresh-btn').dispatch('click');
  await flush();
  boxes = collectCheckboxes();
  assert.equal(boxes[0].cb.checked, true);
  assert.equal(boxes[1].cb.checked, true);
  assert.ok(boxes[0].card.classList.contains('selected'));
  assert.ok(boxes[1].card.classList.contains('selected'));

  // Execute -> sends combined prompt via sidecar.agent.sendMessage and clears selection
  await byId.get('tooling-execute-btn').dispatch('click');
  await flush();
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /D:\\Workspace\\DemoRepo/);
  assert.match(sentMessages[0], /CodeXrayMcp.*code-xray/);
  assert.match(sentMessages[0], /structural-clone/);
  assert.match(sentMessages[0], /Run code-xray MCP analysis\./);
  assert.match(sentMessages[0], /Run structural-clone scan\./);
  assert.equal(byId.get('tooling-execute-btn').disabled, true);
});
