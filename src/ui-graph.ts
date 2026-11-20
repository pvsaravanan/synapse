/**
 * The node map `synapse ui` draws: memories linked to the components (entityName, relatedEntities), files and,
 * optionally, concepts they name. Memories that share a file or component end up next to each other.
 */
import type { Observation } from './types.js';

export type GraphNodeKind = 'memory' | 'entity' | 'file' | 'concept';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Number of links touching the node; the page sizes nodes by it. */
  degree: number;
  /** Memory nodes only: the observation's id. */
  memoryId?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: 'entity' | 'related' | 'file' | 'concept';
}

export interface MemoryGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface GraphOptions {
  files?: boolean;
  concepts?: boolean;
}

/** Retention flags, not topics: as nodes they would link everything that's pinned. */
const SKIP_CONCEPTS = new Set(['pinned', 'important']);

const normFile = (f: string) => f.trim().replace(/^\.\//, '');

export function buildMemoryGraph(observations: Observation[], opts: GraphOptions = {}): MemoryGraph {
  const files = opts.files ?? true;
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const seen = new Set<string>();
  const node = (id: string, kind: GraphNodeKind, label: string) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, kind, label, degree: 0 }));
    return n;
  };
  const link = (from: GraphNode, to: GraphNode, kind: GraphLink['kind']) => {
    const key = from.id + '\0' + to.id;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    from.degree++;
    to.degree++;
    links.push({ source: from.id, target: to.id, kind });
  };

  for (const o of observations) {
    const m = node('m:' + o.id, 'memory', o.title);
    m.memoryId = o.id;
    const entity = o.entityName.trim();
    if (entity) link(m, node('e:' + entity, 'entity', entity), 'entity');
    for (const r of o.relatedEntities) if (r.trim() && r.trim() !== entity) link(m, node('e:' + r.trim(), 'entity', r.trim()), 'related');
    if (files) for (const f of o.filesModified) if (normFile(f)) link(m, node('f:' + normFile(f), 'file', normFile(f)), 'file');
    if (opts.concepts) {
      for (const c of o.concepts) {
        const k = c.trim().toLowerCase();
        if (k && !SKIP_CONCEPTS.has(k)) link(m, node('c:' + k, 'concept', k), 'concept');
      }
    }
  }
  return { nodes: [...nodes.values()], links };
}
