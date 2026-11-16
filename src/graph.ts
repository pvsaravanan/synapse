/**
 * Knowledge graph compatible with the official MCP memory server's
 * entity/relation model, scoped per project.
 */
import type { DB } from './db.js';

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}
export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

function rowEntity(r: Record<string, unknown>): Entity {
  return { name: String(r.name), entityType: String(r.entityType), observations: JSON.parse(String(r.observations || '[]')) };
}

export function createEntities(db: DB, projectId: string, entities: Entity[]): Entity[] {
  const created: Entity[] = [];
  const stmt = db.prepare('INSERT OR IGNORE INTO graph_entities(projectId, name, entityType, observations) VALUES(?,?,?,?)');
  for (const e of entities) {
    if (Number(stmt.run(projectId, e.name, e.entityType, JSON.stringify(e.observations ?? [])).changes) > 0) created.push(e);
  }
  return created;
}

export function createRelations(db: DB, projectId: string, relations: Relation[]): Relation[] {
  const created: Relation[] = [];
  const stmt = db.prepare('INSERT OR IGNORE INTO graph_relations(projectId, fromName, toName, relationType) VALUES(?,?,?,?)');
  for (const r of relations) {
    if (Number(stmt.run(projectId, r.from, r.to, r.relationType).changes) > 0) created.push(r);
  }
  return created;
}

export function addObservations(db: DB, projectId: string, items: { entityName: string; contents: string[] }[]): { entityName: string; added: string[] }[] {
  return items.map(({ entityName, contents }) => {
    const row = db.prepare('SELECT * FROM graph_entities WHERE projectId = ? AND name = ?').get(projectId, entityName) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Entity not found: ${entityName}`);
    const e = rowEntity(row);
    const added = contents.filter((c) => !e.observations.includes(c));
    db.prepare('UPDATE graph_entities SET observations = ? WHERE projectId = ? AND name = ?').run(JSON.stringify([...e.observations, ...added]), projectId, entityName);
    return { entityName, added };
  });
}

export function deleteEntities(db: DB, projectId: string, names: string[]): void {
  for (const n of names) {
    db.prepare('DELETE FROM graph_entities WHERE projectId = ? AND name = ?').run(projectId, n);
    db.prepare('DELETE FROM graph_relations WHERE projectId = ? AND (fromName = ? OR toName = ?)').run(projectId, n, n);
  }
}

export function deleteGraphObservations(db: DB, projectId: string, items: { entityName: string; observations: string[] }[]): void {
  for (const { entityName, observations } of items) {
    const row = db.prepare('SELECT * FROM graph_entities WHERE projectId = ? AND name = ?').get(projectId, entityName) as Record<string, unknown> | undefined;
    if (!row) continue;
    const e = rowEntity(row);
    db.prepare('UPDATE graph_entities SET observations = ? WHERE projectId = ? AND name = ?').run(
      JSON.stringify(e.observations.filter((o) => !observations.includes(o))), projectId, entityName,
    );
  }
}

export function deleteRelations(db: DB, projectId: string, relations: Relation[]): void {
  const stmt = db.prepare('DELETE FROM graph_relations WHERE projectId = ? AND fromName = ? AND toName = ? AND relationType = ?');
  for (const r of relations) stmt.run(projectId, r.from, r.to, r.relationType);
}

export function readGraph(db: DB, projectId: string): { entities: Entity[]; relations: Relation[] } {
  const entities = (db.prepare('SELECT * FROM graph_entities WHERE projectId = ? ORDER BY name').all(projectId) as Record<string, unknown>[]).map(rowEntity);
  const relations = (db.prepare('SELECT fromName, toName, relationType FROM graph_relations WHERE projectId = ?').all(projectId) as Record<string, string>[])
    .map((r) => ({ from: r.fromName, to: r.toName, relationType: r.relationType }));
  return { entities, relations };
}

export function searchNodes(db: DB, projectId: string, query: string): { entities: Entity[]; relations: Relation[] } {
  const q = query.toLowerCase();
  const g = readGraph(db, projectId);
  const entities = g.entities.filter(
    (e) => e.name.toLowerCase().includes(q) || e.entityType.toLowerCase().includes(q) || e.observations.some((o) => o.toLowerCase().includes(q)),
  );
  const names = new Set(entities.map((e) => e.name));
  return { entities, relations: g.relations.filter((r) => names.has(r.from) && names.has(r.to)) };
}

export function openNodes(db: DB, projectId: string, names: string[]): { entities: Entity[]; relations: Relation[] } {
  const set = new Set(names);
  const g = readGraph(db, projectId);
  return { entities: g.entities.filter((e) => set.has(e.name)), relations: g.relations.filter((r) => set.has(r.from) || set.has(r.to)) };
}
