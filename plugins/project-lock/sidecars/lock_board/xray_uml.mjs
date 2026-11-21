/**
 * Focused 1-2 hop Pure-SVG + Mermaid UML extractor over `.xray/index.db`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  expandNeighborhood,
  formatModuleMermaid,
  formatTypeMermaid,
  pushUniqueEdge,
  shortTypeName,
} from './xray_uml_mermaid.mjs';
import { buildSequenceGraph } from './xray_uml_sequence.mjs';
import { buildStateGraph } from './xray_uml_state.mjs';

const DEFAULT_MAX_NODES = 10;
const MAX_TARGET_CHOICES = 24;
const MAX_MEMBERS_PER_NODE = 5;

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row?.ok);
}

function getCols(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name ?? '')));
}

function computeDegree(edges) {
  const degree = new Map();
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  return degree;
}

function buildModuleGraph(db, focus, maxHops, maxNodes) {
  if (!tableExists(db, 'projects')) {
    return { ok: false, error: 'projects table not found in index.db', nodes: [], edges: [], availableTargets: [], mermaid: '' };
  }
  const pCols = getCols(db, 'projects');
  const selectSql = pCols.has('layer')
    ? 'SELECT name, layer, is_external, is_test FROM projects ORDER BY name ASC'
    : "SELECT name, '' AS layer, 0 AS is_external, 0 AS is_test FROM projects ORDER BY name ASC";
  const projects = db.prepare(selectSql).all().map((r) => ({
    name: String(r.name ?? ''),
    layer: String(r.layer ?? ''),
    isExternal: Boolean(r.is_external),
    isTest: Boolean(r.is_test),
  }));
  if (!projects.length) {
    return { ok: false, error: 'No indexed projects', nodes: [], edges: [], availableTargets: [], mermaid: '' };
  }

  const refRows = tableExists(db, 'project_refs')
    ? db.prepare('SELECT from_project, to_project FROM project_refs').all()
    : [];
  const allEdges = refRows.map((r) => ({
    from: String(r.from_project ?? ''),
    to: String(r.to_project ?? ''),
    relation: 'depends',
    label: 'ref',
  }));
  const degree = computeDegree(allEdges);

  const availableTargets = projects
    .filter((p) => !p.isExternal)
    .sort((a, b) => Number(a.isTest) - Number(b.isTest) || (degree.get(b.name) || 0) - (degree.get(a.name) || 0))
    .slice(0, MAX_TARGET_CHOICES)
    .map((p) => p.name);

  const focusLow = String(focus || '').trim().toLowerCase();
  const focusItem =
    projects.find((p) => p.name.toLowerCase() === focusLow) ||
    projects.find((p) => focusLow && p.name.toLowerCase().includes(focusLow)) ||
    projects.find((p) => p.name === availableTargets[0]) ||
    projects[0];

  const byName = new Map(projects.map((p) => [p.name, p]));
  const { selected, rankMap, truncated } = expandNeighborhood(focusItem.name, allEdges, maxHops, maxNodes);

  const nodes = [...selected].map((name) => {
    const p = byName.get(name) || { name, layer: 'External', isExternal: true, isTest: false };
    return {
      id: name,
      name,
      fullName: name,
      kind: p.isTest ? 'test-module' : p.isExternal ? 'external' : 'module',
      subtitle: p.layer || (p.isExternal ? 'External' : 'Project'),
      rank: rankMap.get(name) ?? 0,
      isFocus: name === focusItem.name,
      members: [],
    };
  });

  const edgeMap = new Map();
  for (const e of allEdges) {
    if (selected.has(e.from) && selected.has(e.to)) pushUniqueEdge(edgeMap, e.from, e.to, e.relation, e.label);
  }
  const edges = [...edgeMap.values()];
  return {
    ok: true,
    mode: 'module',
    focus: focusItem.name,
    availableTargets,
    nodes,
    edges,
    truncated,
    mermaid: formatModuleMermaid(nodes, edges),
  };
}

function collectTypeEdges(db, allTypes) {
  const candidates = [];
  for (const t of allTypes) {
    for (const b of t.baseTypes.split(',').map((s) => shortTypeName(s)).filter(Boolean)) {
      candidates.push({ from: t.name, to: b, relation: 'inherits', label: 'extends' });
    }
  }
  if (tableExists(db, 'type_refs')) {
    for (const r of db.prepare('SELECT source_type, target_type, ref_kind FROM type_refs LIMIT 1500').all()) {
      const kind = String(r.ref_kind || 'uses');
      candidates.push({
        from: shortTypeName(r.source_type),
        to: shortTypeName(r.target_type),
        relation: kind === 'base' || kind === 'inherits' ? 'inherits' : 'uses',
        label: kind,
      });
    }
  }
  if (tableExists(db, 'di_registrations')) {
    for (const r of db.prepare('SELECT lifetime, service_type, impl_type FROM di_registrations LIMIT 500').all()) {
      candidates.push({
        from: shortTypeName(r.impl_type),
        to: shortTypeName(r.service_type),
        relation: 'implements',
        label: `DI:${String(r.lifetime || 'scoped')}`,
      });
    }
  }
  return candidates;
}

function buildTypeGraph(db, focus, maxHops, maxNodes) {
  if (!tableExists(db, 'types')) {
    return { ok: false, error: 'types table not found in index.db', nodes: [], edges: [], availableTargets: [], mermaid: '' };
  }
  const tCols = getCols(db, 'types');
  if (!tCols.has('name')) return buildModuleGraph(db, focus, maxHops, maxNodes);

  const sql = `SELECT name, ${tCols.has('full_name') ? 'full_name' : 'name AS full_name'}, ${
    tCols.has('kind') ? 'kind' : "'class' AS kind"
  }, ${tCols.has('project_name') ? 'project_name' : "'' AS project_name"}, ${
    tCols.has('base_types') ? 'base_types' : "'' AS base_types"
  } FROM types ORDER BY name ASC LIMIT 400`;
  const allTypes = db.prepare(sql).all().map((r) => ({
    name: String(r.name ?? ''),
    fullName: String(r.full_name ?? r.name ?? ''),
    kind: String(r.kind || 'class'),
    projectName: String(r.project_name ?? ''),
    baseTypes: String(r.base_types ?? ''),
  }));
  if (!allTypes.length) return buildModuleGraph(db, focus, maxHops, maxNodes);

  const edgeCandidates = collectTypeEdges(db, allTypes);
  const degree = computeDegree(edgeCandidates);
  const typeByName = new Map();
  for (const t of allTypes) if (!typeByName.has(t.name)) typeByName.set(t.name, t);

  const availableTargets = [...typeByName.values()]
    .sort((a, b) => (degree.get(b.name) || 0) - (degree.get(a.name) || 0) || a.name.localeCompare(b.name))
    .slice(0, MAX_TARGET_CHOICES)
    .map((t) => t.name);

  const focusLow = String(focus || '').trim().toLowerCase();
  const focusType =
    allTypes.find((t) => t.fullName.toLowerCase() === focusLow || t.name.toLowerCase() === focusLow) ||
    allTypes.find((t) => focusLow && t.fullName.toLowerCase().includes(focusLow)) ||
    typeByName.get(availableTargets[0]) ||
    allTypes[0];

  const { selected, rankMap, truncated } = expandNeighborhood(focusType.name, edgeCandidates, maxHops, maxNodes);
  const membersStmt = tableExists(db, 'members')
    ? db.prepare('SELECT name, kind, return_type FROM members WHERE owner_type = ? OR owner_type LIKE ? LIMIT 8')
    : null;

  const nodes = [...selected].map((name) => {
    const info = typeByName.get(name);
    const members = [];
    if (membersStmt) {
      for (const m of membersStmt.all(info?.fullName || name, `%.${name}`)) {
        if (members.length >= MAX_MEMBERS_PER_NODE) break;
        members.push({ name: String(m.name ?? ''), kind: String(m.kind ?? ''), returnType: shortTypeName(m.return_type) });
      }
    }
    return {
      id: name,
      name,
      fullName: info?.fullName || name,
      kind: info?.kind || 'external',
      subtitle: info?.projectName || 'External',
      rank: rankMap.get(name) ?? 0,
      isFocus: name === focusType.name,
      members,
    };
  });

  const edgeMap = new Map();
  for (const e of edgeCandidates) {
    if (selected.has(e.from) && selected.has(e.to)) pushUniqueEdge(edgeMap, e.from, e.to, e.relation, e.label);
  }
  const edges = [...edgeMap.values()];
  return {
    ok: true,
    mode: 'type',
    focus: focusType.name,
    availableTargets,
    nodes,
    edges,
    truncated,
    mermaid: formatTypeMermaid(nodes, edges),
  };
}

export function buildFocusedUmlGraph(
  workspacePath,
  { mode = 'type', focus = '', hops = 1, maxNodes = DEFAULT_MAX_NODES } = {}
) {
  const ws = String(workspacePath || '').trim();
  if (!ws) {
    return { ok: false, error: 'workspace is required', nodes: [], edges: [], availableTargets: [], mermaid: '' };
  }
  const indexDbPath = join(ws, '.xray', 'index.db');
  if (!existsSync(indexDbPath)) {
    return {
      ok: false,
      error: `Missing .xray/index.db in ${ws}`,
      workspacePath: ws,
      nodes: [],
      edges: [],
      availableTargets: [],
      mermaid: '',
    };
  }

  const clampedHops = Math.min(2, Math.max(1, Number(hops) || 1));
  const clampedMax = Math.min(14, Math.max(4, Number(maxNodes) || DEFAULT_MAX_NODES));
  let db = null;
  try {
    db = new DatabaseSync(indexDbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000;');
    const modeLow = String(mode || 'type').toLowerCase();
    let result;
    if (modeLow === 'module') result = buildModuleGraph(db, focus, clampedHops, clampedMax);
    else if (modeLow === 'sequence') result = buildSequenceGraph(db, focus, clampedHops, clampedMax);
    else if (modeLow === 'state') result = buildStateGraph(db, focus, clampedHops, Math.max(clampedMax, 12));
    else result = buildTypeGraph(db, focus, clampedHops, clampedMax);
    return { ...result, workspacePath: ws, hops: clampedHops };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      workspacePath: ws,
      nodes: [],
      edges: [],
      availableTargets: [],
      mermaid: '',
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures on read-only DB.
    }
  }
}
