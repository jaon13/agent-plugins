/**
 * Focused 1-2 hop Sequence UML extractor over `.xray/index.db` (`calls` + `messenger_links`).
 */

import { expandNeighborhood, pushUniqueEdge, safeMermaidId, shortTypeName } from './xray_uml_mermaid.mjs';

const MAX_SEQUENCE_STEPS = 34;
const NOISE_TARGETS = new Set([
  'console', 'math', 'string', 'object', 'array', 'json', 'task', 'promise', 'list', 'map', 'set', 'vec', 'option', 'result',
]);

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row?.ok);
}

function resolveParticipantTarget(callerShort, receiverHint, calleeName, typeIndex, refsBySource) {
  const recv = String(receiverHint || '').trim();
  const callee = String(calleeName || '').trim();
  if (recv === 'new') {
    const t = shortTypeName(callee);
    return t || callerShort;
  }

  const strippedRecv = recv.replace(/^this\./i, '').replace(/^self\./i, '').replace(/^_/, '').replace(/^m_/, '');
  const lowRecv = strippedRecv.toLowerCase();
  if (lowRecv && lowRecv !== 'this' && lowRecv !== 'self' && lowRecv !== 'super') {
    const exact = typeIndex.get(lowRecv) || typeIndex.get(`i${lowRecv}`);
    if (exact) return exact;
    const callerRefs = refsBySource.get(callerShort) || [];
    const matchedRef = callerRefs.find(
      (r) => r.toLowerCase() === lowRecv || r.toLowerCase().endsWith(lowRecv) || r.toLowerCase() === `i${lowRecv}`
    );
    if (matchedRef) return matchedRef;
    if (/^[A-Z]/.test(strippedRecv) && !NOISE_TARGETS.has(lowRecv)) {
      return shortTypeName(strippedRecv);
    }
  }

  if (callee.includes('.') || callee.includes('::')) {
    const head = shortTypeName(callee.split(/\.|::/)[0]);
    const exact = typeIndex.get(head.toLowerCase());
    if (exact) return exact;
    if (/^[A-Z]/.test(head) && !NOISE_TARGETS.has(head.toLowerCase())) return head;
  }

  return callerShort;
}

function formatSequenceMermaid(nodes, sequenceSteps) {
  const lines = ['sequenceDiagram'];
  for (const n of nodes) {
    const sid = safeMermaidId(n.id);
    lines.push(`  participant ${sid} as ${n.name}`);
  }
  for (const st of sequenceSteps) {
    const arrow = st.isAsync ? '-->>' : '->>';
    const label = st.trigger && st.trigger !== '<init>' ? `${st.trigger}: ${st.message}` : st.message;
    lines.push(`  ${safeMermaidId(st.from)}${arrow}${safeMermaidId(st.to)}: ${label}`);
  }
  return lines.join('\n');
}

export function buildSequenceGraph(db, focus, maxHops, maxNodes) {
  const hasCalls = tableExists(db, 'calls');
  const hasMsg = tableExists(db, 'messenger_links');
  if (!hasCalls && !hasMsg) {
    return {
      ok: false,
      mode: 'sequence',
      error: 'calls / messenger_links tables not found in index.db',
      nodes: [],
      edges: [],
      sequenceSteps: [],
      availableTargets: [],
      mermaid: '',
    };
  }

  const allTypes = tableExists(db, 'types')
    ? db.prepare('SELECT name, full_name, kind, project_name FROM types LIMIT 800').all()
    : [];
  const typeByName = new Map();
  const typeByLower = new Map();
  for (const t of allTypes) {
    const name = String(t.name ?? '').trim();
    if (!name) continue;
    if (!typeByName.has(name)) {
      typeByName.set(name, {
        name,
        fullName: String(t.full_name ?? name),
        kind: String(t.kind || 'participant'),
        projectName: String(t.project_name ?? ''),
      });
    }
    if (!typeByLower.has(name.toLowerCase())) {
      typeByLower.set(name.toLowerCase(), name);
    }
  }

  const refsBySource = new Map();
  if (tableExists(db, 'type_refs')) {
    for (const r of db.prepare('SELECT source_type, target_type FROM type_refs LIMIT 1500').all()) {
      const src = shortTypeName(r.source_type);
      const tgt = shortTypeName(r.target_type);
      if (!src || !tgt || src === tgt) continue;
      if (!refsBySource.has(src)) refsBySource.set(src, []);
      const list = refsBySource.get(src);
      if (!list.includes(tgt)) list.push(tgt);
    }
  }

  const rawSteps = [];
  if (hasCalls) {
    const callRows = db
      .prepare('SELECT id, file_id, caller_type, caller_member, callee_name, receiver_hint, line FROM calls ORDER BY file_id, line, id LIMIT 2500')
      .all();
    for (const r of callRows) {
      const from = shortTypeName(r.caller_type);
      if (!from) continue;
      const callee = String(r.callee_name || '').trim();
      const recv = String(r.receiver_hint || '').trim();
      const to = resolveParticipantTarget(from, recv, callee, typeByLower, refsBySource);
      if (!to) continue;
      const msg = recv === 'new' ? `new ${shortTypeName(callee)}()` : `${shortTypeName(callee)}()`;
      rawSteps.push({
        orderKey: Number(r.file_id || 0) * 100000 + Number(r.line || 0) * 100 + (Number(r.id || 0) % 100),
        from,
        to,
        trigger: String(r.caller_member || ''),
        message: msg,
        isAsync: false,
        line: Number(r.line || 0),
      });
    }
  }

  if (hasMsg) {
    const msgRows = db
      .prepare('SELECT id, file_id, owner_type, direction, message_type, line FROM messenger_links ORDER BY line, id LIMIT 800')
      .all();
    const receiversByMsg = new Map();
    for (const r of msgRows) {
      if (String(r.direction || '').toLowerCase() !== 'receive') continue;
      const key = shortTypeName(r.message_type);
      if (!receiversByMsg.has(key)) receiversByMsg.set(key, []);
      const owner = shortTypeName(r.owner_type);
      if (owner && !receiversByMsg.get(key).includes(owner)) receiversByMsg.get(key).push(owner);
    }
    for (const r of msgRows) {
      if (String(r.direction || '').toLowerCase() !== 'send') continue;
      const from = shortTypeName(r.owner_type);
      const msgShort = shortTypeName(r.message_type);
      if (!from || !msgShort) continue;
      const targets = receiversByMsg.get(msgShort) || [];
      if (targets.length === 0) {
        rawSteps.push({
          orderKey: Number(r.file_id || 0) * 100000 + Number(r.line || 0) * 100 + 50,
          from,
          to: msgShort,
          trigger: 'Publish',
          message: msgShort,
          isAsync: true,
          line: Number(r.line || 0),
        });
      } else {
        for (const to of targets) {
          rawSteps.push({
            orderKey: Number(r.file_id || 0) * 100000 + Number(r.line || 0) * 100 + 50,
            from,
            to,
            trigger: 'AsyncMsg',
            message: msgShort,
            isAsync: true,
            line: Number(r.line || 0),
          });
        }
      }
    }
  }

  if (rawSteps.length === 0) {
    return {
      ok: false,
      mode: 'sequence',
      error: 'No call or messenger interactions indexed in calls / messenger_links yet.',
      nodes: [],
      edges: [],
      sequenceSteps: [],
      availableTargets: [],
      mermaid: '',
    };
  }

  const crossDegree = new Map();
  const totalDegree = new Map();
  const crossEdges = [];
  for (const s of rawSteps) {
    totalDegree.set(s.from, (totalDegree.get(s.from) || 0) + 1);
    totalDegree.set(s.to, (totalDegree.get(s.to) || 0) + 1);
    if (s.from !== s.to) {
      crossDegree.set(s.from, (crossDegree.get(s.from) || 0) + 1);
      crossDegree.set(s.to, (crossDegree.get(s.to) || 0) + 1);
      crossEdges.push({ from: s.from, to: s.to, relation: s.isAsync ? 'messenger' : 'call', label: s.message });
    }
  }

  const availableTargets = [...totalDegree.keys()]
    .sort((a, b) => (crossDegree.get(b) || 0) - (crossDegree.get(a) || 0) || (totalDegree.get(b) || 0) - (totalDegree.get(a) || 0) || a.localeCompare(b))
    .slice(0, 24);

  const focusLow = String(focus || '').trim().toLowerCase();
  const focusName =
    availableTargets.find((n) => n.toLowerCase() === focusLow) ||
    [...totalDegree.keys()].find((n) => n.toLowerCase() === focusLow) ||
    availableTargets.find((n) => focusLow && n.toLowerCase().includes(focusLow)) ||
    availableTargets[0];

  const { selected, rankMap, truncated: bfsTruncated } = expandNeighborhood(focusName, crossEdges, maxHops, maxNodes);

  rawSteps.sort((a, b) => a.orderKey - b.orderKey);
  const dedupedSteps = [];
  const seenStepKeys = new Set();
  for (const s of rawSteps) {
    if (!selected.has(s.from) || !selected.has(s.to)) continue;
    const key = `${s.from}|${s.to}|${s.message}|${s.line}`;
    if (seenStepKeys.has(key)) continue;
    seenStepKeys.add(key);
    dedupedSteps.push(s);
  }

  const stepTruncated = dedupedSteps.length > MAX_SEQUENCE_STEPS;
  const visibleSteps = dedupedSteps.slice(0, MAX_SEQUENCE_STEPS).map((s, idx) => ({
    seq: idx + 1,
    from: s.from,
    to: s.to,
    trigger: s.trigger,
    message: s.message,
    isAsync: s.isAsync,
    line: s.line,
  }));

  const participantNames = [...selected].sort(
    (a, b) => (rankMap.get(a) ?? 0) - (rankMap.get(b) ?? 0) || a.localeCompare(b)
  );
  const nodes = participantNames.map((name) => {
    const info = typeByName.get(name);
    return {
      id: name,
      name,
      fullName: info?.fullName || name,
      kind: info?.kind || 'participant',
      subtitle: info?.projectName || 'Participant',
      rank: rankMap.get(name) ?? 0,
      isFocus: name === focusName,
      members: [],
    };
  });

  const edgeMap = new Map();
  for (const s of visibleSteps) {
    pushUniqueEdge(edgeMap, s.from, s.to, s.isAsync ? 'messenger' : 'call', s.message);
  }
  const edges = [...edgeMap.values()];

  return {
    ok: true,
    mode: 'sequence',
    focus: focusName,
    availableTargets,
    nodes,
    edges,
    sequenceSteps: visibleSteps,
    truncated: bfsTruncated || stepTruncated,
    mermaid: formatSequenceMermaid(nodes, visibleSteps),
  };
}
