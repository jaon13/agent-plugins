/**
 * Shared BFS neighborhood selector & Mermaid diagram serializer for `.xray/index.db`.
 */

export function shortTypeName(raw) {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return '';
  const withoutGeneric = cleaned.split('<')[0];
  const parts = withoutGeneric.split(/\.|::/);
  return parts[parts.length - 1] || cleaned;
}

export function safeMermaidId(label) {
  return String(label || 'Node').replace(/[^A-Za-z0-9_]/g, '_');
}

export function pushUniqueEdge(edgeMap, from, to, relation, label = '') {
  if (!from || !to || from === to) return;
  const key = `${from}|${to}|${relation}`;
  if (!edgeMap.has(key)) {
    edgeMap.set(key, { from, to, relation, label: label || relation });
  }
}

export function expandNeighborhood(focusName, edgeList, maxHops, maxNodes) {
  const selected = new Set([focusName]);
  const rankMap = new Map([[focusName, 0]]);
  let frontier = [focusName];
  let truncated = false;

  for (let hop = 1; hop <= maxHops; hop += 1) {
    const next = [];
    for (const cur of frontier) {
      for (const e of edgeList) {
        if (e.from !== cur && e.to !== cur) continue;
        const neighbor = e.from === cur ? e.to : e.from;
        if (!neighbor || selected.has(neighbor)) continue;
        if (selected.size >= maxNodes) {
          truncated = true;
          continue;
        }
        selected.add(neighbor);
        rankMap.set(neighbor, e.from === cur ? hop : -hop);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  return { selected, rankMap, truncated };
}

export function formatModuleMermaid(nodes, edges) {
  const lines = ['flowchart LR'];
  for (const n of nodes) lines.push(`  ${safeMermaidId(n.id)}["${n.name}"]`);
  for (const e of edges) lines.push(`  ${safeMermaidId(e.from)} --> ${safeMermaidId(e.to)}`);
  return lines.join('\n');
}

export function formatTypeMermaid(nodes, edges) {
  const lines = ['classDiagram'];
  for (const n of nodes) {
    const sid = safeMermaidId(n.id);
    if (n.members.length > 0) {
      lines.push(`  class ${sid} {`);
      for (const m of n.members) {
        const ret = m.returnType ? ` ${m.returnType}` : '';
        lines.push(`    +${m.name}()${ret}`);
      }
      lines.push('  }');
    } else {
      lines.push(`  class ${sid}`);
    }
  }
  for (const e of edges) {
    const arrow = e.relation === 'inherits' ? '--|>' : e.relation === 'implements' ? '..|>' : '-->';
    lines.push(`  ${safeMermaidId(e.from)} ${arrow} ${safeMermaidId(e.to)} : ${e.label}`);
  }
  return lines.join('\n');
}
