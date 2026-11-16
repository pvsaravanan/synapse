import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { toolMode, VERSION, type ToolMode } from './config.js';
import { buildProjectContext } from './context.js';
import { getDb, type DB } from './db.js';
import { formatDetail, formatIndex, formatTimeline, indexLine } from './disclosure.js';
import { ingestCommits } from './git.js';
import * as graph from './graph.js';
import { archiveExpired, exportProject, retentionReport } from './maintenance.js';
import { detectProject } from './project.js';
import { search } from './search.js';
import { activeSession, endSession, recentSessions, startSession } from './sessions.js';
import {
  getObservations,
  promoteObservation,
  projectStats,
  recordAccess,
  recordFeedback,
  setStatus,
  storeObservation,
  timeline,
} from './store.js';
import { OBSERVATION_TYPES, type ProjectInfo } from './types.js';

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Text => ({ content: [{ type: 'text', text: t }], isError: true });

export function suggestTopicKey(type: string, title: string, entityName?: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48);
  const family: Record<string, string> = {
    decision: 'decisions', 'trade-off': 'decisions', reasoning: 'decisions', 'why-it-exists': 'architecture',
    'how-it-works': 'architecture', gotcha: 'gotchas', 'problem-solution': 'fixes', 'what-changed': 'changes', discovery: 'notes',
    'session-request': 'sessions',
  };
  return [family[type] ?? 'notes', entityName ? slug(entityName) : '', slug(title)].filter(Boolean).join('/');
}

export function createServer(opts: { db?: DB; project?: ProjectInfo; mode?: ToolMode } = {}): McpServer {
  const db = opts.db ?? getDb();
  let project: ProjectInfo = opts.project ?? detectProject(process.env.SYNAPSE_PROJECT_ROOT || process.cwd());
  const mode = opts.mode ?? toolMode();
  const sessionId = () => activeSession(db, project.id)?.id;

  const server = new McpServer({ name: 'synapse', version: VERSION });

  server.registerTool(
    'synapse_store',
    {
      title: 'Store Memory',
      description:
        'Persist a project memory future sessions should not have to rediscover. Types: gotcha (critical pitfall), decision (architecture choice), ' +
        'problem-solution (bug fix), how-it-works (explanation), what-changed (change), discovery (insight), why-it-exists (rationale), ' +
        'trade-off (compromise), session-request (original goal). Pass topicKey to revise an evolving topic in place. ' +
        'Credentials are redacted before write. Do not store greetings, trivial reads or commands.',
      inputSchema: {
        entityName: z.string().describe('Component/area this belongs to, e.g. "auth-module"'),
        type: z.enum(OBSERVATION_TYPES),
        title: z.string().describe('Concise title, ~5-10 words'),
        narrative: z.string().describe('Full description'),
        facts: z.array(z.string()).optional().describe('Structured facts, e.g. "Default timeout: 60s"'),
        filesModified: z.array(z.string()).optional(),
        concepts: z.array(z.string()).optional().describe('Keywords; "pinned"/"important" make it retention-immune'),
        topicKey: z.string().optional().describe('Stable key for upserts, e.g. "decisions/auth/session-model"'),
        progress: z
          .object({ feature: z.string(), status: z.enum(['in-progress', 'completed', 'blocked']), completion: z.number().min(0).max(100).optional() })
          .optional(),
        relatedCommits: z.array(z.string()).optional(),
        relatedEntities: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const r = storeObservation(db, { ...args, projectId: project.id, sessionId: sessionId(), source: 'agent' });
      const verb = { created: 'Stored', 'updated-topic': 'Updated topic', 'merged-duplicate': 'Merged into existing' }[r.action];
      return text(`${verb} ${indexLine(r.observation)}`);
    },
  );

  server.registerTool(
    'synapse_store_reasoning',
    {
      title: 'Store Reasoning',
      description: 'Record WHY a decision was made: the choice, rationale, rejected alternatives, constraints and risks. Use for non-obvious design choices.',
      inputSchema: {
        entityName: z.string(),
        decision: z.string().describe('What was decided'),
        rationale: z.string().describe('Why'),
        alternatives: z.array(z.string()).optional().describe('Options considered and rejected'),
        constraints: z.array(z.string()).optional(),
        risks: z.array(z.string()).optional(),
        filesModified: z.array(z.string()).optional(),
        relatedCommits: z.array(z.string()).optional(),
        topicKey: z.string().optional(),
      },
    },
    async (a) => {
      const narrative = [
        `Decision: ${a.decision}`,
        `Rationale: ${a.rationale}`,
        a.alternatives?.length ? `Alternatives rejected:\n${a.alternatives.map((x) => `- ${x}`).join('\n')}` : '',
        a.constraints?.length ? `Constraints:\n${a.constraints.map((x) => `- ${x}`).join('\n')}` : '',
        a.risks?.length ? `Risks:\n${a.risks.map((x) => `- ${x}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const r = storeObservation(db, {
        projectId: project.id,
        entityName: a.entityName,
        type: 'reasoning',
        title: a.decision.slice(0, 100),
        narrative,
        facts: [...(a.constraints ?? []).map((c) => `Constraint: ${c}`), ...(a.risks ?? []).map((r) => `Risk: ${r}`)],
        filesModified: a.filesModified,
        relatedCommits: a.relatedCommits,
        topicKey: a.topicKey,
        sessionId: sessionId(),
        concepts: ['reasoning'],
      });
      return text(`Stored reasoning ${indexLine(r.observation)}`);
    },
  );

  server.registerTool(
    'synapse_search',
    {
      title: 'Search Memory',
      description:
        'Search project memory (BM25 full-text blended with recency/importance decay). Returns a compact index (L1); ' +
        'expand interesting ids with synapse_detail. Empty query browses the most relevant recent memories.',
      inputSchema: {
        query: z.string().describe('Natural-language or keyword query'),
        type: z.array(z.enum(OBSERVATION_TYPES)).optional(),
        status: z.enum(['active', 'resolved', 'archived', 'all']).optional(),
        entityName: z.string().optional(),
        since: z.string().optional().describe('ISO date lower bound'),
        limit: z.number().int().min(1).max(50).optional(),
        maxTokens: z.number().int().min(50).optional(),
        scope: z.enum(['project', 'global']).optional().describe('global searches all projects'),
      },
    },
    async (a) => {
      const global = a.scope === 'global';
      const hits = search(db, { ...a, projectId: global ? undefined : project.id, limit: a.limit ?? 10 });
      if (hits.length === 0) {
        const stats = projectStats(db, global ? undefined : project.id);
        const active = stats.byStatus.active ?? 0;
        return text(
          stats.total === 0
            ? 'No Synapse memories exist for this project yet (fresh project). Do not repeat the search this turn.'
            : `No memories matched "${a.query}". ${active} active of ${stats.total} total memories; try broader terms, status "all", or an empty query to browse.`,
        );
      }
      return text(formatIndex(hits, { query: a.query, global, maxTokens: a.maxTokens }));
    },
  );

  server.registerTool(
    'synapse_detail',
    {
      title: 'Memory Detail',
      description: 'Full record(s) for memory ids (L3): narrative, facts, files, provenance.',
      inputSchema: { ids: z.array(z.number().int()).min(1).max(20) },
    },
    async ({ ids }) => {
      const obs = getObservations(db, ids);
      if (obs.length === 0) return fail(`No memories found for ids ${ids.join(', ')}`);
      recordAccess(db, obs.map((o) => o.id));
      return text(obs.map(formatDetail).join('\n\n---\n\n'));
    },
  );

  server.registerTool(
    'synapse_timeline',
    {
      title: 'Memory Timeline',
      description: 'Chronological context around one memory (L2): what happened just before and after it.',
      inputSchema: { anchorId: z.number().int(), before: z.number().int().min(0).max(20).optional(), after: z.number().int().min(0).max(20).optional() },
    },
    async ({ anchorId, before, after }) => text(formatTimeline(timeline(db, anchorId, before ?? 3, after ?? 3))),
  );

  server.registerTool(
    'synapse_resolve',
    {
      title: 'Resolve Memory',
      description: 'Mark memories resolved (done / fixed / no longer current) or archived so search stays focused on live work.',
      inputSchema: { ids: z.array(z.number().int()).min(1), status: z.enum(['resolved', 'archived', 'active']).optional() },
    },
    async ({ ids, status }) => {
      const n = setStatus(db, ids, status ?? 'resolved', project.id);
      return text(`Marked ${n} memor${n === 1 ? 'y' : 'ies'} as ${status ?? 'resolved'}.`);
    },
  );

  server.registerTool(
    'synapse_project_context',
    {
      title: 'Project Context Brief',
      description:
        'Default first step for non-trivial work: pass the user\'s actual task. Returns a bounded, task-lensed brief ' +
        '(bugfix/feature/refactor/release/docs/test/onboarding) with start-here files, relevant memories, cautions and the last handoff.',
      inputSchema: { task: z.string(), maxTokens: z.number().int().min(200).max(4000).optional() },
    },
    async ({ task, maxTokens }) => text(buildProjectContext(db, project, task, { maxTokens }).text),
  );

  server.registerTool(
    'synapse_session_start',
    {
      title: 'Start Session',
      description: 'Begin a tracked session; returns the previous handoff summaries. Optionally rebind to another project root.',
      inputSchema: { agent: z.string().optional(), projectRoot: z.string().optional() },
    },
    async ({ agent, projectRoot }) => {
      if (projectRoot) project = detectProject(projectRoot);
      const s = startSession(db, project.id, { agent });
      const prev = recentSessions(db, project.id, 3).filter((p) => p.id !== s.id);
      return text(
        [`Session ${s.id} started for ${project.id}.`, prev.length ? '\nPrevious sessions:' : '\nNo previous session summaries.',
          ...prev.map((p) => `- ${(p.endedAt ?? p.startedAt).slice(0, 16)} ${p.agent ?? ''}: ${p.summary}`)].join('\n'),
      );
    },
  );

  server.registerTool(
    'synapse_session_end',
    {
      title: 'End Session',
      description: 'Close the active session with a handoff summary: what was done, what is left, and where to pick up.',
      inputSchema: { summary: z.string() },
    },
    async ({ summary }) => {
      const s = activeSession(db, project.id) ?? startSession(db, project.id);
      endSession(db, s.id, summary);
      return text(`Session ${s.id} closed with handoff summary.`);
    },
  );

  server.registerTool(
    'synapse_feedback',
    {
      title: 'Memory Feedback',
      description: 'Record whether a memory helped, conflicted with current code, was outdated (auto-resolves) or was corrected. Adjusts future ranking.',
      inputSchema: { id: z.number().int(), signal: z.enum(['helpful', 'conflicted', 'outdated', 'corrected']), note: z.string().optional() },
    },
    async ({ id, signal, note }) => {
      if (getObservations(db, [id]).length === 0) return fail(`Memory #${id} not found`);
      recordFeedback(db, id, signal, note);
      return text(`Recorded ${signal} feedback on #${id}.`);
    },
  );

  server.registerTool(
    'synapse_qualify',
    {
      title: 'Qualify Candidate',
      description: 'Promote auto-captured candidate memories (from hooks) to qualified so they rank normally and can appear in briefs.',
      inputSchema: { ids: z.array(z.number().int()).min(1) },
    },
    async ({ ids }) => text(`Qualified ${ids.filter((id) => promoteObservation(db, id)).length} memories.`),
  );

  server.registerTool(
    'synapse_suggest_topic_key',
    {
      title: 'Suggest Topic Key',
      description: 'Generate a stable topicKey for an evolving topic so later stores revise it instead of duplicating.',
      inputSchema: { type: z.enum(OBSERVATION_TYPES), title: z.string(), entityName: z.string().optional() },
    },
    async ({ type, title, entityName }) => text(suggestTopicKey(type, title, entityName)),
  );

  server.registerTool(
    'synapse_retention',
    {
      title: 'Memory Health',
      description: 'Show memory counts, retention zones and archive candidates; set archive=true to archive expired memories.',
      inputSchema: { archive: z.boolean().optional() },
    },
    async ({ archive }) => {
      const stats = projectStats(db, project.id);
      const rep = retentionReport(db, project.id);
      const lines = [
        `Project ${project.id}: ${stats.total} memories (${Object.entries(stats.byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
        `Active by type: ${Object.entries(stats.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
        `Retention zones: active ${rep.zones.active}, stale ${rep.zones.stale}, archive-candidate ${rep.zones['archive-candidate']}`,
      ];
      if (archive) lines.push(`Archived ${archiveExpired(db, project.id).length} expired memories.`);
      else if (rep.archiveCandidates.length) lines.push(...rep.archiveCandidates.slice(0, 10).map((o) => `- ${indexLine(o)}`));
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'synapse_ingest_git',
    {
      title: 'Ingest Git History',
      description: 'Convert recent commits into source-backed memories (merge/version-bump/lockfile-only commits are filtered). Idempotent per commit.',
      inputSchema: { count: z.number().int().min(1).max(500).optional(), since: z.string().optional() },
    },
    async ({ count, since }) => {
      const r = ingestCommits(db, project.id, project.rootPath, { count, since });
      return text(`Ingested ${r.ingested} commits (skipped ${r.skippedExisting} existing, ${r.skippedNoise} noise).`);
    },
  );

  if (mode === 'full') registerFullTools(server, db, () => project);
  return server;
}

function registerFullTools(server: McpServer, db: DB, proj: () => ProjectInfo): void {
  const entity = z.object({ name: z.string(), entityType: z.string(), observations: z.array(z.string()) });
  const relation = z.object({ from: z.string(), to: z.string(), relationType: z.string() });
  const json = (v: unknown) => text(JSON.stringify(v, null, 2));

  server.registerTool('create_entities', { description: 'Knowledge graph: create entities', inputSchema: { entities: z.array(entity) } },
    async ({ entities }) => json(graph.createEntities(db, proj().id, entities)));
  server.registerTool('create_relations', { description: 'Knowledge graph: create relations (active voice)', inputSchema: { relations: z.array(relation) } },
    async ({ relations }) => json(graph.createRelations(db, proj().id, relations)));
  server.registerTool('add_observations', { description: 'Knowledge graph: add observations to entities', inputSchema: { observations: z.array(z.object({ entityName: z.string(), contents: z.array(z.string()) })) } },
    async ({ observations }) => {
      try {
        return json(graph.addObservations(db, proj().id, observations));
      } catch (e) {
        return fail((e as Error).message);
      }
    });
  server.registerTool('delete_entities', { description: 'Knowledge graph: delete entities and their relations', inputSchema: { entityNames: z.array(z.string()) } },
    async ({ entityNames }) => (graph.deleteEntities(db, proj().id, entityNames), text('Entities deleted')));
  server.registerTool('delete_observations', { description: 'Knowledge graph: delete entity observations', inputSchema: { deletions: z.array(z.object({ entityName: z.string(), observations: z.array(z.string()) })) } },
    async ({ deletions }) => (graph.deleteGraphObservations(db, proj().id, deletions), text('Observations deleted')));
  server.registerTool('delete_relations', { description: 'Knowledge graph: delete relations', inputSchema: { relations: z.array(relation) } },
    async ({ relations }) => (graph.deleteRelations(db, proj().id, relations), text('Relations deleted')));
  server.registerTool('read_graph', { description: 'Knowledge graph: read the whole project graph', inputSchema: {} },
    async () => json(graph.readGraph(db, proj().id)));
  server.registerTool('search_nodes', { description: 'Knowledge graph: search entities', inputSchema: { query: z.string() } },
    async ({ query }) => json(graph.searchNodes(db, proj().id, query)));
  server.registerTool('open_nodes', { description: 'Knowledge graph: open entities by name', inputSchema: { names: z.array(z.string()) } },
    async ({ names }) => json(graph.openNodes(db, proj().id, names)));
  server.registerTool('synapse_export', { description: 'Export all project memories and sessions as JSON', inputSchema: {} },
    async () => json(exportProject(db, proj().id)));
}

export async function serveStdio(mode?: ToolMode): Promise<void> {
  const server = createServer({ mode });
  await server.connect(new StdioServerTransport());
}
