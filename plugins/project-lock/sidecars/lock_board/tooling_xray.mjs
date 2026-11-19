/**
 * Reads `~/.agents/tooling.json`, inspects MCP/CLI binary availability,
 * and summarizes active workspace `.xray/index.db` + `.xray/reviews/*.json`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MAX_REVIEWS = 10;
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_ITEMS = 5;

const TOOLING_CATALOG = {
  'code-xray': {
    category: 'MCP Server',
    summary: '다언어(.NET·Rust·Web/Svelte·Python) 인덱스·그래프·시맨틱 MCP',
    description:
      '.xray/index.db와 Roslyn MSBuildWorkspace를 결합해 심볼 개요(get_type_overview), 기능 슬라이스(get_feature_slice), 의존 관계(get_architecture_links), 호출자/블래스트 반경, 구조 클론 및 grep_code MCP 도구를 제공합니다.',
    actionHint:
      'code-xray MCP(get_feature_slice, get_type_overview, get_architecture_links, grep_code, find_structural_clones)로 현재 워크스페이스 심볼·의존 구조와 변경 영향 범위를 분석해 줘.',
  },
  'uia-mcp': {
    category: 'MCP Server',
    summary: '데스크톱 UI 자동화·스크린샷·입력 제어 MCP (선택)',
    description:
      'UI Automation 기반으로 대상 앱 실행/연결, UI 트리 조회, 스크린샷, 클릭 및 키 입력 도구를 제공합니다.',
    actionHint:
      'UI Automation MCP(uia_launch_or_attach, uia_get_tree, uia_screenshot)로 대상 데스크톱 앱 화면 구조와 상태를 점검해 줘.',
  },
  'xray-index': {
    category: 'CLI Indexer',
    summary: '다중 언어 심볼·슬라이스·의존성 SQLite(.xray/index.db) 고속 인덱서',
    description:
      'C#/XAML, Rust, TS/JS/Svelte, Python 프로젝트를 파싱해 .xray/index.db에 색인하고, slice·search·deps·partials 명령으로 경량 탐색을 지원합니다.',
    actionHint:
      'xray_run.py xray-index build / status / slice 를 실행해 현재 워크스페이스 .xray/index.db 인덱스를 최신화하고 핵심 구조를 요약해 줘.',
  },
  'xray-grep': {
    category: 'CLI Search',
    summary: 'tree-sitter 심볼 태깅 기반 Review-First 병렬 검색·리뷰 생성기',
    description:
      '다중 언어 소스를 병렬 검색하고 감싸는 심볼(enclosing_symbol)과 카테고리(code/test/config/docs)를 태깅한 뒤 .xray/reviews/에 세션 충돌 없는 리뷰 매니페스트(.json/.md)를 생성합니다.',
    actionHint:
      'xray_run.py xray-grep --save-review 로 심볼 태깅 기반 검색을 준비하고 .xray/reviews/*.json 리뷰 매니페스트 Workflow 사용 가능 상태를 확인해 줘.',
  },
  'structural-clone': {
    category: 'CLI Analyzer',
    summary: '다언어(C#/XAML/Rust/TS/JS/Svelte/Python) AST 구조 중복·클론 탐지 엔진',
    description:
      'tree-sitter 구문 트리와 Rabin-Karp 해싱을 사용해 포맷이나 식별자 이름이 달라도 구조적으로 중복된 코드·스타일·템플릿 클론을 탐지합니다.',
    actionHint:
      'xray_run.py structural-clone (또는 find_structural_clones)을 실행해 현재 워크스페이스의 중복 코드·XAML/Svelte/Rust 클론 후보를 분석해 줘.',
  },
  opengrep: {
    category: 'Security SAST',
    summary: '보안 취약점·오염 흐름(Taint) 다중 언어 정적 분석 스캐너',
    description:
      'security-rules.yml 룰셋을 기준으로 명령 주입, 경로 탐색, 안전하지 않은 역직렬화 등 다중 언어 보안 취약점을 정적 탐지합니다.',
    actionHint:
      'xray_run.py opengrep scan --config @codexray/templates/opengrep/security-rules.yml 로 현재 워크스페이스 보안 정적 분석(SAST)을 수행하고 결과를 요약해 줘.',
  },
};

const ROOT_CATALOG = {
  agentToolingRoot: {
    label: 'AgentTooling 통합 루트',
    summary: '에이전트 전용 CLI·MCP·글로벌 래퍼(tooling.json) 기준 폴더',
    description:
      'CodeXray 등 에이전트 공통 툴링과 글로벌 래퍼 구성을 관리하는 루트 폴더입니다.',
  },
  codeXrayRoot: {
    label: 'CodeXray 툴킷',
    summary: '.NET/Rust/Web/Svelte/Python 정적 분석·인덱싱·구조 클론·Grep 엔진',
    description:
      'CodeXrayMcp(.NET 10), xray-index/xray-grep/structural-clone(Rust), OpenGrep SAST, verify_dotnet/verify_rust 게이트 스크립트를 제공합니다.',
  },
};

export function resolveToolingJsonPath(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const envPath = process.env.TOOLING_JSON?.trim();
  if (envPath) return resolve(envPath);
  return join(homedir(), '.agents', 'tooling.json');
}

export function normalizeWorkspacePath(uriOrPath) {
  const raw = String(uriOrPath ?? '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().startsWith('file://')) {
    try {
      return resolve(fileURLToPath(raw));
    } catch {
      return '';
    }
  }
  try {
    return resolve(raw);
  } catch {
    return raw;
  }
}

export function parseWorkspacesParam(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [trimmed];
      }
    } else {
      items = trimmed.split(/[;,]/);
    }
  }

  const out = [];
  const seen = new Set();
  const isWin = process.platform === 'win32';
  for (const item of items) {
    const norm = normalizeWorkspacePath(item);
    if (!norm) continue;
    const key = isWin ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function statSafe(targetPath) {
  if (!targetPath || !existsSync(targetPath)) {
    return { exists: false, sizeBytes: 0, mtimeMs: null };
  }
  try {
    const st = statSync(targetPath);
    return {
      exists: st.isFile() || st.isDirectory(),
      isFile: st.isFile(),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { exists: false, sizeBytes: 0, mtimeMs: null };
  }
}

function buildBinaryEntry(id, label, exePath) {
  const st = statSafe(exePath);
  const meta = TOOLING_CATALOG[id] || {
    category: 'Tool',
    summary: `${label} 실행 바이너리`,
    description: `${label} 도구입니다.`,
    actionHint: `${label}(${id}) 도구를 사용해 현재 워크스페이스를 점검해 줘.`,
  };
  return {
    id,
    label,
    category: meta.category,
    summary: meta.summary,
    description: meta.description,
    actionHint: meta.actionHint || `${label}(${id}) 도구를 사용해 현재 워크스페이스를 점검해 줘.`,
    path: exePath || '',
    exists: Boolean(st.exists && st.isFile),
    sizeBytes: st.sizeBytes,
    mtimeMs: st.mtimeMs,
  };
}

export function getToolingSnapshot({ toolingJsonPath } = {}) {
  const resolvedPath = resolveToolingJsonPath(toolingJsonPath);
  const toolingJsonExists = existsSync(resolvedPath);
  let data = {};
  let toolingJsonError = null;

  if (toolingJsonExists) {
    try {
      const raw = readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed;
      } else {
        toolingJsonError = 'tooling.json must contain a JSON object';
      }
    } catch (err) {
      toolingJsonError = err instanceof Error ? err.message : String(err);
    }
  }

  const agentToolingRoot = String(data.agentToolingRoot ?? '');
  const codeXrayRoot = String(data.codeXrayRoot ?? '');
  const codeXrayExe = String(
    data.codeXrayMcpExe ||
      data.roslynGraphMcpExe ||
      (codeXrayRoot ? join(codeXrayRoot, 'bin', 'code-xray-mcp', 'CodeXrayMcp.exe') : '')
  );
  const uiaExe = String(data.uiaMcpExe || data.rpaMcpExe || '');
  const cxBin = codeXrayRoot ? join(codeXrayRoot, 'bin') : '';

  const binaries = [
    buildBinaryEntry('code-xray', 'CodeXrayMcp', codeXrayExe),
    ...(uiaExe ? [buildBinaryEntry('uia-mcp', 'UI Automation MCP', uiaExe)] : []),
    buildBinaryEntry('xray-index', 'xray-index', cxBin ? join(cxBin, 'xray-index.exe') : ''),
    buildBinaryEntry('xray-grep', 'xray-grep', cxBin ? join(cxBin, 'xray-grep.exe') : ''),
    buildBinaryEntry(
      'structural-clone',
      'structural-clone',
      cxBin ? join(cxBin, 'structural-clone.exe') : ''
    ),
    buildBinaryEntry(
      'opengrep',
      'opengrep',
      cxBin ? join(cxBin, 'opengrep', 'opengrep.exe') : ''
    ),
  ];

  const rootInfo = [
    { id: 'agentToolingRoot', ...ROOT_CATALOG.agentToolingRoot, path: agentToolingRoot },
    { id: 'codeXrayRoot', ...ROOT_CATALOG.codeXrayRoot, path: codeXrayRoot },
  ];

  return {
    toolingJsonPath: resolvedPath,
    toolingJsonExists,
    toolingJsonError,
    agentToolingRoot,
    codeXrayRoot,
    rootInfo,
    binaries,
  };
}

function readTableCount(db, tableName) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${tableName}`).get();
    return Number(row?.cnt ?? 0);
  } catch {
    return null;
  }
}

export function inspectIndexDb(indexDbPath) {
  const st = statSafe(indexDbPath);
  if (!st.exists || !st.isFile) {
    return {
      exists: false,
      dbPath: indexDbPath,
      sizeBytes: 0,
      mtimeMs: null,
      meta: {},
      counts: {},
      error: null,
    };
  }

  let db;
  try {
    db = new DatabaseSync(indexDbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    const meta = {};
    try {
      const metaRows = db.prepare('SELECT key, value FROM meta').all();
      for (const r of metaRows) {
        meta[String(r.key ?? '')] = String(r.value ?? '');
      }
    } catch {
      // Older or partial index schema without meta table.
    }

    const counts = {
      projects: readTableCount(db, 'projects'),
      files: readTableCount(db, 'files'),
      types: readTableCount(db, 'types'),
      members: readTableCount(db, 'members'),
    };

    const updatedEpoch = meta.updated_epoch ? Number(meta.updated_epoch) : null;

    return {
      exists: true,
      dbPath: indexDbPath,
      sizeBytes: st.sizeBytes,
      mtimeMs: st.mtimeMs,
      schemaVersion: meta.schema_version ?? null,
      repoRoot: meta.repo_root ?? null,
      updatedEpoch: Number.isFinite(updatedEpoch) ? updatedEpoch : null,
      meta,
      counts,
      error: null,
    };
  } catch (err) {
    return {
      exists: true,
      dbPath: indexDbPath,
      sizeBytes: st.sizeBytes,
      mtimeMs: st.mtimeMs,
      meta: {},
      counts: {},
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures on read-only inspection.
    }
  }
}

function summarizeReviewManifest(filePath, st) {
  const fileName = basename(filePath);
  if (st.sizeBytes > MAX_REVIEW_BYTES) {
    return {
      fileName,
      filePath,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.sizeBytes,
      runId: fileName.replace(/\.json$/i, ''),
      pattern: '(file exceeds 2MB preview cap)',
      isRegex: false,
      createdAt: null,
      totalMatches: 0,
      fileCount: 0,
      statusCounts: {},
      preview: [],
      error: null,
    };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const items = Array.isArray(data?.matches)
      ? data.matches
      : Array.isArray(data?.items)
        ? data.items
        : [];
    const statusCounts = {};
    const uniqueFiles = new Set();
    const preview = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const rawStatus = String(item.status ?? '').trim().toLowerCase();
      const rawDisp = String(item.disposition ?? '').trim().toLowerCase();
      const status =
        rawStatus && rawStatus !== 'pending'
          ? rawStatus
          : rawDisp || rawStatus || 'pending';
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      const fpath = String(item.file ?? item.rel_path ?? item.path ?? '');
      if (fpath) uniqueFiles.add(fpath);
      if (preview.length < MAX_PREVIEW_ITEMS) {
        preview.push({
          file: fpath,
          line: Number(item.line ?? item.start_line ?? 0) || null,
          symbol: String(item.enclosing_symbol ?? item.symbol ?? ''),
          status,
        });
      }
    }

    const totalMatches = Number(
      data?.total_matches ?? data?.totalMatches ?? data?.match_count ?? items.length
    );
    const fileCount = Number(
      data?.file_count ??
        data?.fileCount ??
        (Array.isArray(data?.files) ? data.files.length : uniqueFiles.size)
    );

    return {
      fileName,
      filePath,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.sizeBytes,
      runId: String(data?.run_id ?? data?.runId ?? fileName.replace(/\.json$/i, '')),
      pattern: String(data?.pattern ?? data?.query ?? ''),
      isRegex: Boolean(data?.is_regex ?? data?.isRegex),
      createdAt: data?.created_at ?? data?.createdAt ?? data?.timestamp ?? null,
      totalMatches: Number.isFinite(totalMatches) ? totalMatches : 0,
      fileCount: Number.isFinite(fileCount) ? fileCount : 0,
      statusCounts,
      preview,
      error: null,
    };
  } catch (err) {
    return {
      fileName,
      filePath,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.sizeBytes,
      runId: fileName.replace(/\.json$/i, ''),
      pattern: '',
      isRegex: false,
      createdAt: null,
      totalMatches: 0,
      fileCount: 0,
      statusCounts: {},
      preview: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function inspectReviewsDir(reviewsDir) {
  if (!reviewsDir || !existsSync(reviewsDir)) return [];
  let entries = [];
  try {
    entries = readdirSync(reviewsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.json')) continue;
    const full = join(reviewsDir, ent.name);
    const st = statSafe(full);
    if (!st.exists) continue;
    files.push({ full, st });
  }

  files.sort((a, b) => (b.st.mtimeMs ?? 0) - (a.st.mtimeMs ?? 0));
  return files.slice(0, MAX_REVIEWS).map((f) => summarizeReviewManifest(f.full, f.st));
}

export function inspectWorkspaceXray(workspacePath, source = 'active') {
  const norm = normalizeWorkspacePath(workspacePath);
  const xrayDir = join(norm, '.xray');
  const indexDb = inspectIndexDb(join(xrayDir, 'index.db'));
  const reviews = inspectReviewsDir(join(xrayDir, 'reviews'));
  return {
    workspacePath: norm,
    name: basename(norm) || norm,
    source,
    xrayDirExists: existsSync(xrayDir),
    indexDb,
    reviews,
  };
}

export function getXraySnapshot({ activeWorkspaces = [], fallbackWorkspaces = [] } = {}) {
  const activeList = parseWorkspacesParam(activeWorkspaces);
  const fallbackList = parseWorkspacesParam(fallbackWorkspaces);

  const targets = [];
  const seen = new Set();
  const isWin = process.platform === 'win32';

  const addTarget = (ws, source) => {
    const key = isWin ? ws.toLowerCase() : ws;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ ws, source });
  };

  for (const ws of activeList) addTarget(ws, 'active');
  if (targets.length === 0) {
    for (const ws of fallbackList) addTarget(ws, 'lock');
  }

  return {
    activeWorkspaces: activeList,
    workspaces: targets.map((t) => inspectWorkspaceXray(t.ws, t.source)),
  };
}
