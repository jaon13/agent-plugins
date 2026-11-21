/**
 * Focused 1-2 hop State Machine UML extractor over `.xray/index.db` (`state_transitions`).
 */

import { expandNeighborhood, pushUniqueEdge, safeMermaidId, shortTypeName } from './xray_uml_mermaid.mjs';

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row?.ok);
}

function readSchemaVersion(db) {
  if (!tableExists(db, 'meta')) return '0';
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return String(row?.value ?? '0');
}

function formatStateMermaid(transitions, terminalStates) {
  const lines = ['stateDiagram-v2'];
  const emitted = new Set();
  for (const t of transitions) {
    const fromId = t.fromState === '(init)' || t.fromState === '*' ? '[*]' : safeMermaidId(t.fromState);
    const toId = safeMermaidId(t.toState);
    const lbl = t.guardExpr ? `${t.triggerMember} [${t.guardExpr}]` : t.triggerMember;
    const edgeLine = `  ${fromId} --> ${toId} : ${lbl}`;
    if (!emitted.has(edgeLine)) {
      emitted.add(edgeLine);
      lines.push(edgeLine);
    }
  }
  for (const term of terminalStates) {
    lines.push(`  note right of ${safeMermaidId(term)} : No outgoing transition (terminal)`);
  }
  return lines.join('\n');
}

export function buildStateGraph(db, focus, maxHops, maxNodes) {
  if (!tableExists(db, 'state_transitions')) {
    return {
      ok: false,
      mode: 'state',
      error: 'state_transitions table missing — click Refresh Index to upgrade .xray/index.db to schema v2.',
      nodes: [],
      edges: [],
      terminalStates: [],
      availableTargets: [],
      mermaid: '',
    };
  }

  const rows = db
    .prepare(
      'SELECT owner_type, machine_name, from_state, to_state, trigger_member, guard_expr, line FROM state_transitions ORDER BY machine_name ASC, line ASC, id ASC LIMIT 2000'
    )
    .all()
    .map((r) => ({
      ownerType: String(r.owner_type ?? ''),
      machineName: String(r.machine_name ?? ''),
      fromState: String(r.from_state ?? '*'),
      toState: String(r.to_state ?? ''),
      triggerMember: String(r.trigger_member ?? '<init>'),
      guardExpr: String(r.guard_expr ?? ''),
      line: Number(r.line ?? 0),
    }))
    .filter((r) => r.machineName && r.toState);

  if (rows.length === 0) {
    const schemaVer = readSchemaVersion(db);
    return {
      ok: false,
      mode: 'state',
      error:
        schemaVer === '1'
          ? 'Legacy schema v1 index — click Refresh Index to scan state transitions into schema v2.'
          : 'No state machine transitions detected in indexed files yet.',
      nodes: [],
      edges: [],
      terminalStates: [],
      availableTargets: [],
      mermaid: '',
    };
  }

  const byMachine = new Map();
  for (const r of rows) {
    if (!byMachine.has(r.machineName)) byMachine.set(r.machineName, []);
    byMachine.get(r.machineName).push(r);
  }

  const availableTargets = [...byMachine.keys()]
    .sort((a, b) => byMachine.get(b).length - byMachine.get(a).length || a.localeCompare(b))
    .slice(0, 24);

  const rawFocus = String(focus || '').trim();
  const [machineHint, stateHint] = rawFocus.includes('::')
    ? rawFocus.split('::', 2)
    : [rawFocus, ''];
  const hintLow = machineHint.toLowerCase();
  const focusMachine =
    availableTargets.find((m) => m.toLowerCase() === hintLow) ||
    availableTargets.find(
      (m) =>
        hintLow &&
        (m.toLowerCase().includes(hintLow) ||
          byMachine.get(m).some((r) => shortTypeName(r.ownerType).toLowerCase() === hintLow))
    ) ||
    availableTargets[0];

  const mRows = byMachine.get(focusMachine) || [];
  const allRealStates = new Set();
  const initialStates = new Set();
  const outgoingCount = new Map();
  const incomingCount = new Map();

  for (const r of mRows) {
    if (r.fromState !== '(init)' && r.fromState !== '*') {
      allRealStates.add(r.fromState);
      outgoingCount.set(r.fromState, (outgoingCount.get(r.fromState) || 0) + 1);
    } else if (r.fromState === '(init)') {
      initialStates.add(r.toState);
    }
    if (r.toState !== '(init)' && r.toState !== '*') {
      allRealStates.add(r.toState);
      incomingCount.set(r.toState, (incomingCount.get(r.toState) || 0) + 1);
    }
  }

  const terminalSet = new Set(
    [...allRealStates].filter((st) => (incomingCount.get(st) || 0) > 0 && (outgoingCount.get(st) || 0) === 0)
  );

  const concreteEdges = [];
  for (const r of mRows) {
    if (r.fromState === '(init)' || r.fromState === '*') continue;
    const lbl = r.guardExpr ? `${r.triggerMember} [${r.guardExpr}]` : r.triggerMember;
    concreteEdges.push({ from: r.fromState, to: r.toState, relation: 'transition', label: lbl });
  }

  const hasOnlyWildcard = concreteEdges.length === 0 && mRows.some((r) => r.fromState === '*');
  const bfsEdges = hasOnlyWildcard
    ? mRows
        .filter((r) => r.fromState === '*')
        .map((r) => ({ from: 'Any (*)', to: r.toState, relation: 'transition', label: r.triggerMember }))
    : concreteEdges;

  const anchorState =
    (stateHint && allRealStates.has(stateHint) ? stateHint : '') ||
    (allRealStates.has(rawFocus) ? rawFocus : '') ||
    [...initialStates][0] ||
    (hasOnlyWildcard ? 'Any (*)' : [...allRealStates][0]);

  const { selected, rankMap, truncated } = expandNeighborhood(anchorState, bfsEdges, maxHops, maxNodes);

  const includeInitMarker = mRows.some((r) => r.fromState === '(init)' && selected.has(r.toState));
  const includeWildcard = mRows.some((r) => r.fromState === '*' && selected.has(r.toState));

  const nodes = [];
  if (includeInitMarker) {
    nodes.push({
      id: '[*]',
      name: '[*] Init',
      fullName: `${focusMachine}.__init__`,
      kind: 'init-marker',
      subtitle: 'Entry point',
      rank: -1,
      isFocus: false,
      members: [],
    });
  }
  if (includeWildcard) {
    nodes.push({
      id: 'Any (*)',
      name: 'Any (*)',
      fullName: `${focusMachine}.*`,
      kind: 'wildcard-state',
      subtitle: 'Unguarded reset',
      rank: -1,
      isFocus: anchorState === 'Any (*)',
      members: [],
    });
  }

  for (const st of [...selected]) {
    if (st === 'Any (*)' || st === '[*]') continue;
    const isInitial = initialStates.has(st);
    const isTerminal = terminalSet.has(st);
    const kind = isTerminal ? 'terminal-state' : isInitial ? 'initial-state' : 'state';
    const members = mRows
      .filter((r) => r.fromState === st)
      .slice(0, 4)
      .map((r) => ({ name: r.triggerMember, kind: r.guardExpr || 'to', returnType: r.toState }));
    const ownerShort = shortTypeName(mRows.find((r) => r.fromState === st || r.toState === st)?.ownerType || focusMachine);
    nodes.push({
      id: st,
      name: st,
      fullName: `${focusMachine}::${st}`,
      kind,
      subtitle: isTerminal ? 'No exit' : isInitial ? `Init · ${ownerShort}` : ownerShort,
      rank: rankMap.get(st) ?? 0,
      isFocus: st === anchorState,
      members,
    });
  }

  const visibleTransitions = [];
  const edgeMap = new Map();
  for (const r of mRows) {
    if (!selected.has(r.toState)) continue;
    const fromId = r.fromState === '(init)' ? '[*]' : r.fromState === '*' ? 'Any (*)' : r.fromState;
    if (r.fromState !== '(init)' && r.fromState !== '*' && !selected.has(r.fromState)) continue;
    const lbl = r.guardExpr ? `${r.triggerMember} [${r.guardExpr}]` : r.triggerMember;
    pushUniqueEdge(edgeMap, fromId, r.toState, r.fromState === '(init)' ? 'inherits' : 'uses', lbl);
    visibleTransitions.push(r);
  }

  const edges = [...edgeMap.values()];
  const terminalStates = [...terminalSet].filter((s) => selected.has(s));

  return {
    ok: true,
    mode: 'state',
    focus: focusMachine,
    availableTargets,
    nodes,
    edges,
    terminalStates,
    truncated,
    mermaid: formatStateMermaid(visibleTransitions, terminalStates),
  };
}
