import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createLockBoardController,
  createStandaloneHttpServer,
  openLockDb,
  readActiveClaims,
} from '../main.mjs';
import { ensureClaimSchema } from '../claim_db.mjs';
import { buildBoardTasks, parseChecklistMarkdown } from '../telemetry_board.mjs';
import { collectBrainDirIndex } from '../telemetry_readers.mjs';
import { getXraySnapshot, inspectByteRagCache } from '../tooling_xray.mjs';
import { buildFocusedUmlGraph } from '../xray_uml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOARD_DIR = join(__dirname, '..');

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'lock_board_phase2_'));
}

function createSampleXrayDb(indexDbPath) {
  mkdirSync(dirname(indexDbPath), { recursive: true });
  const db = new DatabaseSync(indexDbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (name TEXT PRIMARY KEY, csproj_path TEXT NOT NULL, root_dir TEXT NOT NULL, layer TEXT NOT NULL, is_external INTEGER NOT NULL, is_test INTEGER NOT NULL);
    CREATE TABLE project_refs (from_project TEXT NOT NULL, to_project TEXT NOT NULL, PRIMARY KEY (from_project, to_project));
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, project_name TEXT NOT NULL, abs_path TEXT NOT NULL UNIQUE, rel_path TEXT NOT NULL, lang TEXT NOT NULL, mtime_ns INTEGER NOT NULL, size_bytes INTEGER NOT NULL, content_hash TEXT NOT NULL, line_count INTEGER NOT NULL);
    CREATE TABLE types (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, project_name TEXT NOT NULL, namespace TEXT NOT NULL, name TEXT NOT NULL, full_name TEXT NOT NULL, kind TEXT NOT NULL, accessibility TEXT NOT NULL, is_partial INTEGER NOT NULL, base_types TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, owner_type TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, return_type TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
    CREATE TABLE type_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, source_type TEXT NOT NULL, target_type TEXT NOT NULL, ref_kind TEXT NOT NULL, line INTEGER NOT NULL);
    CREATE TABLE di_registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, lifetime TEXT NOT NULL, service_type TEXT NOT NULL, impl_type TEXT NOT NULL, line INTEGER NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1'), ('updated_epoch', '1760000000');
    INSERT INTO projects VALUES ('App.UI', 'a.csproj', 'src', 'Presentation', 0, 0), ('App.Core', 'c.csproj', 'src', 'Core', 0, 0), ('App.Tests', 't.csproj', 'tests', 'Tests', 0, 1);
    INSERT INTO project_refs VALUES ('App.UI', 'App.Core'), ('App.Tests', 'App.Core');
    INSERT INTO files VALUES (1, 'App.UI', 'D:/WS/src/MainVm.cs', 'MainVm.cs', 'csharp', 1, 100, 'abc', 30);
    INSERT INTO types VALUES (1, 1, 'App.UI', 'App.UI', 'MainVm', 'App.UI.MainVm', 'class', 'public', 0, 'BaseVm', 1, 30),
                             (2, 1, 'App.Core', 'App.Core', 'LockService', 'App.Core.LockService', 'class', 'public', 0, 'ILockService', 1, 20),
                             (3, 1, 'App.Core', 'App.Core', 'ILockService', 'App.Core.ILockService', 'interface', 'public', 0, '', 1, 10);
    INSERT INTO members VALUES (1, 1, 'App.UI.MainVm', 'RefreshAsync', 'method', 'RefreshAsync()', 'Task', 5, 15);
    INSERT INTO type_refs VALUES (1, 1, 'App.UI.MainVm', 'App.Core.ILockService', 'field', 6);
    INSERT INTO di_registrations VALUES (1, 1, 'Singleton', 'App.Core.ILockService', 'App.Core.LockService', 10);
  `);
  db.close();
}

test('claim_db readActiveClaims reads 4-tier claims alongside legacy locks', () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const nowSec = 1_760_100_000;
    const db = openLockDb(dbPath);
    ensureClaimSchema(db);
    db.prepare(`
      INSERT INTO lock_claims (
        claim_id, module_key, scope_key, file_relpath, lock_mode, tool_call_id,
        owner_id, module_root, is_shared, owner_project_id, owner_transcript,
        workspace, child_ids_json, tags_json, acquired_at, last_active_at, reserved_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, '[]', '["edit"]', ?, ?, NULL)
    `).run(
      'clm-1',
      '05.Tooling/02.UiAutomationMcp',
      '05.Tooling/02.UiAutomationMcp@abcd1234',
      'src/viewa.cs',
      'FILE_WRITE',
      '',
      'conv-a',
      'D:\\WS\\05.Tooling\\02.UiAutomationMcp',
      'D:\\WS',
      nowSec - 20,
      nowSec - 5
    );
    db.prepare(`
      INSERT INTO lock_claims (
        claim_id, module_key, scope_key, file_relpath, lock_mode, tool_call_id,
        owner_id, module_root, is_shared, owner_project_id, owner_transcript,
        workspace, child_ids_json, tags_json, acquired_at, last_active_at, reserved_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, '[]', '["edit"]', ?, ?, NULL)
    `).run(
      'clm-2',
      '05.Tooling/02.UiAutomationMcp',
      '05.Tooling/02.UiAutomationMcp@abcd1234',
      'src/viewb.cs',
      'FILE_WRITE',
      '',
      'conv-b',
      'D:\\WS\\05.Tooling\\02.UiAutomationMcp',
      'D:\\WS',
      nowSec - 10,
      nowSec - 2
    );

    const claims = readActiveClaims(db, { now: nowSec, ttlSeconds: 1200 });
    db.close();
    assert.equal(claims.length, 2);
    assert.equal(claims[0].fileRelpath, 'src/viewa.cs');
    assert.equal(claims[1].fileRelpath, 'src/viewb.cs');
    assert.equal(claims[0].lockMode, 'FILE_WRITE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry_board projects Kanban tasks from claims, queue, checklists, and .system_generated', () => {
  const dir = makeTempDir();
  try {
    const nowSec = 1_760_200_000;
    const brainRoot = join(dir, 'brain');
    const c1 = join(brainRoot, 'conv-active-1111');
    const c2 = join(brainRoot, 'conv-blocked-2222');
    const c3 = join(brainRoot, 'conv-done-3333');
    mkdirSync(join(c1, '.system_generated', 'subagents'), { recursive: true });
    mkdirSync(join(c2, '.system_generated'), { recursive: true });
    mkdirSync(join(c3, '.system_generated'), { recursive: true });

    writeFileSync(
      join(c1, 'task.md'),
      '# Auth Refactor\n- [x] Map callers\n- [/] Edit ViewA.cs\n- [ ] Verify suite\n'
    );
    writeFileSync(
      join(c1, '.system_generated', 'subagents', 'sub1.json'),
      JSON.stringify({ role: 'Code Reviewer', typeName: 'reviewer' })
    );
    writeFileSync(join(c3, 'task.md'), '# Cleanup Task\n- [x] Remove dead file\n- [x] Run tests\n');

    const parsed = parseChecklistMarkdown(readFileSync(join(c1, 'task.md'), 'utf-8'));
    assert.deepEqual(parsed.counts, { total: 3, todo: 1, doing: 1, done: 1 });

    const board = buildBoardTasks({
      claims: [
        {
          claimId: 'c1',
          moduleKey: '01.Apps/DesktopClient',
          fileRelpath: 'src/viewa.cs',
          lockMode: 'FILE_WRITE',
          ownerId: 'conv-active-1111',
          workspace: 'D:\\WS\\DesktopClient',
          childIds: [],
          lastActiveAt: nowSec - 10,
          idleSeconds: 10,
        },
      ],
      queue: [
        {
          id: 9,
          moduleKey: '01.Apps/DesktopClient',
          lockMode: 'FILE_WRITE',
          fileRelpath: 'src/viewa.cs',
          waiterConvId: 'conv-blocked-2222',
          waiterTitle: 'Waiting UI Polish',
          waiterWorkspace: 'D:\\WS\\DesktopClient',
          status: 'waiting',
          position: 1,
          updatedAt: nowSec - 4,
        },
      ],
      brainRoots: [brainRoot],
      now: nowSec,
    });

    assert.deepEqual(board.counts, { todo: 0, in_progress: 1, blocked: 1, done: 1 });
    const blocked = board.tasks.find((t) => t.id === 'conv-blocked-2222');
    const active = board.tasks.find((t) => t.id === 'conv-active-1111');
    const done = board.tasks.find((t) => t.id === 'conv-done-3333');
    assert.equal(blocked?.status, 'blocked');
    assert.match(blocked?.blockedReason || '', /Queue #1 on 01\.Apps\/DesktopClient/);
    assert.equal(active?.status, 'in_progress');
    assert.equal(active?.subagentCount, 1);
    assert.equal(active?.todoCounts.done, 1);
    assert.equal(done?.status, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectByteRagCache and buildFocusedUmlGraph read workspace cache and .xray/index.db UML cleanly', () => {
  const dir = makeTempDir();
  try {
    const ws = join(dir, 'repo');
    const fakeHome = join(dir, 'home');
    mkdirSync(join(ws, '.agents', 'cache', 'bytebrain_knowledge'), { recursive: true });
    writeFileSync(join(ws, '.agents', 'cache', 'byterag_index.bin'), Buffer.alloc(4096));
    writeFileSync(join(ws, '.agents', 'cache', 'bytebrain_knowledge', 'note1.md'), '# Note 1\n');
    writeFileSync(join(ws, '.agents', 'cache', 'bytebrain_knowledge', 'note2.md'), '# Note 2\n');

    const byteRag = inspectByteRagCache(ws, fakeHome, 1_760_000_000);
    assert.equal(byteRag.scope, 'workspace');
    assert.equal(byteRag.indexBin.exists, true);
    assert.equal(byteRag.indexBin.sizeBytes, 4096);
    assert.equal(byteRag.knowledgeDir.docCount, 2);

    createSampleXrayDb(join(ws, '.xray', 'index.db'));
    const typeGraph = buildFocusedUmlGraph(ws, { mode: 'type', focus: 'MainVm', hops: 2 });
    assert.equal(typeGraph.ok, true);
    assert.equal(typeGraph.focus, 'MainVm');
    assert.ok(typeGraph.nodes.some((n) => n.name === 'ILockService'));
    assert.ok(typeGraph.nodes.some((n) => n.name === 'LockService'));
    assert.match(typeGraph.mermaid, /^classDiagram/);
    assert.match(typeGraph.mermaid, /class MainVm/);

    const modGraph = buildFocusedUmlGraph(ws, { mode: 'module', focus: 'App.Core', hops: 1 });
    assert.equal(modGraph.ok, true);
    assert.equal(modGraph.nodes.length, 3);
    assert.match(modGraph.mermaid, /^flowchart LR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('controller /api/xray/uml, /api/xray/refresh, and /api/xray/check work with strict validation', async () => {
  const dir = makeTempDir();
  try {
    const dbPath = join(dir, 'locks.db');
    const ws = join(dir, 'repo');
    createSampleXrayDb(join(ws, '.xray', 'index.db'));
    const calls = [];
    const controller = createLockBoardController({
      dbPath,
      includeGitDirty: false,
      homeDir: dir,
      execRunner: async (cmd, args) => {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: `ok: ${args.join(' ')}`, stderr: '' };
      },
    });
    const server = createStandaloneHttpServer(controller);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const umlRes = await fetch(`${base}/api/xray/uml?workspace=${encodeURIComponent(ws)}&mode=type&focus=MainVm`);
      assert.equal(umlRes.status, 200);
      const uml = await umlRes.json();
      assert.equal(uml.ok, true);
      assert.equal(uml.focus, 'MainVm');

      const badRes = await fetch(`${base}/api/xray/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: join(dir, 'nonexistent') }),
      });
      assert.equal(badRes.status, 400);

      mkdirSync(join(dir, '.agents', 'bin'), { recursive: true });
      writeFileSync(join(dir, '.agents', 'bin', 'xray_run.py'), '# stub');
      const chkRes = await fetch(`${base}/api/xray/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: ws }),
      });
      assert.equal(chkRes.status, 200);
      const chk = await chkRes.json();
      assert.equal(chk.ok, true);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args.includes('check_consistency.py'));
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compiled Svelte dist bundle (when built) preserves Strict CSP and Antigravity classic HTML tags', () => {
  const distHtml = join(BOARD_DIR, 'dist', 'index.html');
  const distJs = join(BOARD_DIR, 'dist', 'app.js');
  const distCss = join(BOARD_DIR, 'dist', 'styles.css');
  if (!existsSync(distHtml)) return;
  const html = readFileSync(distHtml, 'utf-8');
  const js = readFileSync(distJs, 'utf-8');
  const css = readFileSync(distCss, 'utf-8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<script src="\/preload\.js"><\/script>/);
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.doesNotMatch(html, /\scrossorigin/i);
  assert.doesNotMatch(html, /type="module"/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(css, /!important/);
  assert.match(js, /getWorkspaceUris/);
  assert.match(js, /onWorkspaceChange/);
  assert.match(js, /toggleConversation/);
  assert.match(js, /sendMessage/);
});

test('collectBrainDirIndex caches large brain roots and invalidates on root mtime change or TTL', () => {
  const dir = makeTempDir();
  try {
    const brainRoot = join(dir, 'brain');
    mkdirSync(brainRoot, { recursive: true });
    for (let i = 0; i < 45; i += 1) {
      mkdirSync(join(brainRoot, `conv-${String(i).padStart(3, '0')}`), { recursive: true });
    }
    const baseMs = Date.now();
    const first = collectBrainDirIndex([brainRoot], baseMs);
    assert.equal(first.size, 45);

    const addedDir = join(brainRoot, 'conv-new-child');
    mkdirSync(addedDir, { recursive: true });
    utimesSync(brainRoot, new Date(baseMs + 5000), new Date(baseMs + 5000));
    const afterAdd = collectBrainDirIndex([brainRoot], baseMs + 5000);
    assert.equal(afterAdd.size, 46);
    assert.ok(afterAdd.has('conv-new-child'));

    rmSync(addedDir, { recursive: true, force: true });
    utimesSync(brainRoot, new Date(baseMs + 5000), new Date(baseMs + 5000));
    const cachedWithinTtl = collectBrainDirIndex([brainRoot], baseMs + 10000);
    assert.equal(cachedWithinTtl.size, 46);
    const expiredTtl = collectBrainDirIndex([brainRoot], baseMs + 25000);
    assert.equal(expiredTtl.size, 45);
    assert.equal(expiredTtl.has('conv-new-child'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getXraySnapshot auto-discovers depth-1 indexed subprojects under a monorepo root', () => {
  const dir = makeTempDir();
  try {
    const subProj = join(dir, '01.CodeXray');
    mkdirSync(join(dir, 'node_modules', 'ignored'), { recursive: true });
    createSampleXrayDb(join(subProj, '.xray', 'index.db'));
    createSampleXrayDb(join(dir, 'node_modules', 'ignored', '.xray', 'index.db'));

    const snap = getXraySnapshot({ activeWorkspaces: [dir] });
    assert.equal(snap.workspaces.length, 2);
    assert.equal(snap.workspaces[0].source, 'active');
    assert.equal(snap.workspaces[0].indexDb.exists, false);
    assert.equal(snap.workspaces[1].name, '01.CodeXray');
    assert.equal(snap.workspaces[1].source, 'subproject');
    assert.equal(snap.workspaces[1].indexDb.exists, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildFocusedUmlGraph supports sequence and state modes plus v1 fallback', async () => {
  const dir = makeTempDir();
  try {
    const ws = join(dir, 'ws');
    const dbPath = join(ws, '.xray', 'index.db');
    createSampleXrayDb(dbPath);

    // 1. Legacy v1 index gives helpful upgrade prompt in state mode
    const legacyState = buildFocusedUmlGraph(ws, { mode: 'state' });
    assert.equal(legacyState.ok, false);
    assert.match(legacyState.error, /Refresh Index/);

    // 2. Populate calls, messenger_links, and state_transitions (schema v2)
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, caller_type TEXT NOT NULL, caller_member TEXT NOT NULL, callee_name TEXT NOT NULL, receiver_hint TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE messenger_links (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, owner_type TEXT NOT NULL, direction TEXT NOT NULL, message_type TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE state_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, owner_type TEXT NOT NULL, machine_name TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, trigger_member TEXT NOT NULL, guard_expr TEXT NOT NULL, line INTEGER NOT NULL);
      UPDATE meta SET value = '2' WHERE key = 'schema_version';
      INSERT INTO types VALUES (4, 1, 'App.UI', 'App.UI', 'AlarmHandler', 'App.UI.AlarmHandler', 'class', 'public', 0, '', 1, 20);
      INSERT INTO calls VALUES
        (1, 1, 'App.UI.MainVm', 'StartCommand', 'LockService', 'new', 10),
        (2, 1, 'App.UI.MainVm', 'StartCommand', 'AcquireAsync', '_lockService', 12),
        (3, 1, 'App.Core.LockService', 'AcquireAsync', 'ValidateAsync', 'this', 15);
      INSERT INTO messenger_links VALUES
        (1, 1, 'App.Core.LockService', 'send', 'LockAcquiredMsg', 18),
        (2, 1, 'App.UI.AlarmHandler', 'receive', 'LockAcquiredMsg', 5);
      INSERT INTO state_transitions VALUES
        (1, 1, 'App.Core.LockService', 'RunState', '(init)', 'Idle', '<init>', '', 4),
        (2, 1, 'App.Core.LockService', 'RunState', 'Idle', 'Running', 'AcquireAsync', '_state == RunState.Idle', 14),
        (3, 1, 'App.Core.LockService', 'RunState', 'Running', 'Paused', 'Pause', 'case RunState.Running', 22),
        (4, 1, 'App.Core.LockService', 'RunState', 'Paused', 'Alarm', 'Trip', 'case RunState.Paused', 28);
    `);
    db.close();

    const seq1 = buildFocusedUmlGraph(ws, { mode: 'sequence', focus: 'MainVm', hops: 1 });
    assert.equal(seq1.ok, true);
    assert.equal(seq1.mode, 'sequence');
    assert.ok(seq1.sequenceSteps.some((s) => s.from === 'MainVm' && s.to === 'LockService'));
    assert.equal(seq1.sequenceSteps.some((s) => s.to === 'AlarmHandler'), false);

    const seq2 = buildFocusedUmlGraph(ws, { mode: 'sequence', focus: 'MainVm', hops: 2 });
    assert.equal(seq2.ok, true);
    assert.ok(seq2.sequenceSteps.some((s) => s.from === 'LockService' && s.to === 'AlarmHandler' && s.isAsync));
    assert.match(seq2.mermaid, /^sequenceDiagram/);

    const st1 = buildFocusedUmlGraph(ws, { mode: 'state', focus: 'RunState', hops: 1 });
    assert.equal(st1.ok, true);
    assert.equal(st1.mode, 'state');
    assert.equal(st1.focus, 'RunState');
    assert.ok(st1.nodes.some((n) => n.id === 'Idle'));
    assert.ok(st1.nodes.some((n) => n.id === 'Running'));
    assert.equal(st1.nodes.some((n) => n.id === 'Alarm'), false);

    const st2 = buildFocusedUmlGraph(ws, { mode: 'state', focus: 'RunState::Running', hops: 2 });
    assert.equal(st2.ok, true);
    assert.ok(st2.terminalStates.includes('Alarm'));
    assert.ok(st2.nodes.some((n) => n.id === 'Alarm' && n.kind === 'terminal-state'));
    assert.match(st2.mermaid, /^stateDiagram-v2/);

    // Wildcard-only state machine (Python unguarded assignments) shows Any (*) and all targets
    const dbWild = new DatabaseSync(dbPath);
    dbWild.exec(`
      INSERT INTO state_transitions VALUES
        (10, 1, 'PyWorker', 'PyWorker.status', '*', 'reviewed', 'mark', '', 5),
        (11, 1, 'PyWorker', 'PyWorker.status', '*', 'applied', 'apply', '', 9);
    `);
    dbWild.close();
    const stWild = buildFocusedUmlGraph(ws, { mode: 'state', focus: 'PyWorker.status', hops: 1 });
    assert.equal(stWild.ok, true);
    assert.ok(stWild.nodes.some((n) => n.id === 'reviewed'));
    assert.ok(stWild.nodes.some((n) => n.id === 'applied'));

    // 3. HTTP /api/xray/uml routes sequence & state cleanly
    const ctrl = createLockBoardController({ dbPath: join(dir, 'locks.db'), includeGitDirty: false });
    const server = createStandaloneHttpServer(ctrl);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      const res = await fetch(`${base}/api/xray/uml?workspace=${encodeURIComponent(ws)}&mode=state&focus=${encodeURIComponent('RunState::Running')}&hops=2`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.mode, 'state');
      assert.ok(body.terminalStates.includes('Alarm'));
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
