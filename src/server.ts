import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { hooksInstalled, toolMode, VERSION, type ToolMode } from './config.js';
import { teamAutoImport } from './team.js';
import { buildProjectContext } from './context.js';
import { getDb, openDatabase, type DB } from './db.js';
import { formatDetail, formatIndex, formatTimeline, indexLine } from './disclosure.js';
import { consolidateSession } from './consolidate.js';
import { changesFor } from './freshness.js';
import { ingestCommits } from './git.js';
import { autoSummary, recordFileEdit, recordGoal } from './hooks.js';
import * as graph from './graph.js';
import {
  getLongTerm,
  listLongTerm,
  LT_KINDS,
  LT_SCOPES,
  LT_STATES,
  ltLine,
  promoteToLongTerm,
  proposeLongTerm,
  reviewLongTerm,
  supersedeLongTerm,
} from './longterm.js';
import { archiveExpired, exportProject, retentionReport } from './maintenance.js';
import { detectProject } from './project.js';
import { hybridSearch } from './embed.js';
import {
  activeSession,
  addCheckpoint,
  closeOrphanedSessions,
  endSession,
  getSession,
  recentSessions,
  registerServerSession,
  releaseServerSession,
  startSession,
} from './sessions.js';
import {
  getObservations,
  promoteObservation,
  projectStats,
  recordAccess,
  recordFeedback,
  refreshSessionHashes,
  setStatus,
  storeObservation,
  timeline,
} from './store.js';
import { OBSERVATION_TYPES, type ProjectInfo } from './types.js';
import { WorktreeTracker } from './worktree.js';

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

/** Tools that must always ask the user (Claude Code honors the marker; other agents must be configured not to pre-approve them). */
export const GATED_TOOLS = ['synapse_lt_approve'];
const REQUIRES_USER = 'anthropic/requiresUserInteraction';
/**
 * Claude Code defers MCP tools behind tool search: the model sees only their names until it loads them, which makes
 * an agent less likely to reach for memory unprompted. The everyday tools are marked to load at session start; the
 * rest stay deferred to save context. Other agents ignore the marker.
 */
const ALWAYS_LOAD = 'anthropic/alwaysLoad';
export const CORE_TOOLS = [
  'synapse_project_context', 'synapse_search', 'synapse_detail', 'synapse_store', 'synapse_store_reasoning', 'synapse_feedback', 'synapse_session_end',
];
const toolNameRegistry = new WeakMap<McpServer, string[]>();

/** Every tool name the server registers in a mode (full = all). */
export function toolNames(mode: ToolMode = 'full'): string[] {
  const server = createServer({ db: openDatabase(':memory:'), mode, project: { id: 'x', name: 'x', rootPath: process.cwd() }, hooks: true });
  return [...(toolNameRegistry.get(server) ?? [])];
}

/** Clients known to show MCP server instructions to the model; they get the brief there, not on the first call. */
const CLIENTS_SHOWING_INSTRUCTIONS = new Set(['claude-code']);

const USAGE_HINT = [
  'Synapse is this project\'s memory, shared across sessions and agents. Current code and the user\'s request win over memory.',
  '- Before non-trivial work, call synapse_project_context with the task. Search before re-investigating a past bug or decision.',
  '- Store non-obvious fixes, gotchas and decisions with synapse_store as you go (name the files). End with synapse_session_end.',
].join('\n');
const RECOVER_HINT = '- If your context was summarized or you lost track of the task, call synapse_project_context again: it includes this session\'s progress so far.';

/** Without hooks, a rolling checkpoint is written at most this often (tool calls or ms), unless the brief asks for one. */
const CHECKPOINT_EVERY_CALLS = 10;
const CHECKPOINT_EVERY_MS = 5 * 60_000;
/** Without hooks, the working tree is also checked on this interval, for edits made after the agent's last tool call. */
const POLL_MS = 15_000;

export interface ServerOptions {
  db?: DB;
  project?: ProjectInfo;
  mode?: ToolMode;
  /** Lifecycle hooks are installed for this agent (default: SYNAPSE_HOOKS). Without them, the server delivers the brief and runs the session. */
  hooks?: boolean;
  /** Without hooks: how often to check the working tree between tool calls (ms). */
  pollMs?: number;
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const db = opts.db ?? getDb();
  let project: ProjectInfo = opts.project ?? detectProject(process.env.SYNAPSE_PROJECT_ROOT || process.cwd());
  const mode = opts.mode ?? toolMode();
  const hooks = opts.hooks ?? hooksInstalled();
  // Teammates' memories from the repo's .synapse/memory.jsonl, if it changed since the last load (never fatal).
  try { teamAutoImport(db, project); } catch { /* a bad team file must not stop the server */ }

  // Without hooks, the server stands in for them: the brief goes into its instructions (shown at session start by
  // clients that support them) or onto the first tool result, and one session spans the server process.
  const brief = hooks ? '' : buildProjectContext(db, project, '', { maxTokens: 700 }).text;
  const instructions = hooks ? USAGE_HINT : `${USAGE_HINT}\n${RECOVER_HINT}${brief ? `\n\n${brief}` : ''}`;
  const server = new McpServer({ name: 'synapse', version: VERSION }, { instructions });
  let ownSession: string | undefined;
  let briefed = hooks;
  // Edits are detected by comparing the git working tree between tool calls, from the moment the server starts.
  let tracker = hooks ? undefined : new WorktreeTracker(project.rootPath);
  let sessionCalls = 0;
  let checkpoint = { calls: 0, at: Date.now(), summary: '' };
  let summaryKept = '';
  let poller: ReturnType<typeof setInterval> | undefined;
  const clientName = () => server.server.getClientVersion()?.name ?? '';
  /** Adopt a session as the server's own: register its pid (for orphan cleanup) and start polling the working tree. */
  const adopt = (id: string) => {
    ownSession = id;
    sessionCalls = 0;
    checkpoint = { calls: 0, at: Date.now(), summary: '' };
    summaryKept = '';
    registerServerSession(db, id);
    if (!poller && tracker?.enabled) {
      poller = setInterval(() => {
        try {
          trackEdits();
          keepSummary();
        } catch {
          /* the database may be closed */
        }
      }, opts.pollMs ?? POLL_MS);
      poller.unref();
    }
  };
  const ensureOwnSession = () => {
    if (hooks || (ownSession && getSession(db, ownSession)?.status === 'active')) return;
    // Sessions of servers that were killed without shutting down (Copilot CLI) are closed first.
    closeOrphanedSessions(db, project.id, (id) => autoSummary(db, project, id));
    adopt(startSession(db, project.id, { agent: clientName() || 'mcp' }).id);
  };
  const trackEdits = () => {
    if (!tracker?.enabled || !ownSession) return;
    const agent = clientName() || 'the agent';
    for (const rel of tracker.poll()) {
      recordFileEdit(db, project, ownSession, rel, `Edited ${rel}`,
        `Changed in the working tree while ${agent} was connected (detected by the Synapse server, so it may include edits made outside the agent).`);
    }
  };
  /** Keep the session summary current, so a server killed without shutting down still leaves one. */
  const keepSummary = () => {
    if (!ownSession) return;
    const summary = autoSummary(db, project, ownSession);
    if (!summary || summary === summaryKept) return;
    db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(summary, ownSession);
    summaryKept = summary;
  };
  /** Rolling checkpoint of the server's own session: what a compaction would lose. */
  const writeCheckpoint = (force = false) => {
    if (!ownSession) return;
    keepSummary();
    checkpoint.calls++;
    const due = force || checkpoint.calls >= CHECKPOINT_EVERY_CALLS || Date.now() - checkpoint.at >= CHECKPOINT_EVERY_MS;
    if (!due) return;
    const summary = autoSummary(db, project, ownSession);
    if (!summary || summary === checkpoint.summary) return;
    addCheckpoint(db, project.id, ownSession, { summary });
    checkpoint = { calls: 0, at: Date.now(), summary };
  };
  const endOwnSession = () => {
    trackEdits();
    const id = ownSession;
    ownSession = undefined;
    if (!id) return;
    releaseServerSession(db, id);
    if (getSession(db, id)?.status !== 'active') return;
    refreshSessionHashes(db, id, project.rootPath);
    endSession(db, id, autoSummary(db, project, id));
    consolidateSession(db, project, id);
  };
  const sessionId = () => (!hooks && ownSession ? ownSession : activeSession(db, project.id)?.id);

  const names: string[] = [];
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((...args: unknown[]) => {
    const name = args[0] as string;
    names.push(name);
    if (CORE_TOOLS.includes(name) && args[1] && typeof args[1] === 'object') {
      const config = args[1] as { _meta?: Record<string, unknown> };
      config._meta = { ...config._meta, [ALWAYS_LOAD]: true };
    }
    const handler = args[args.length - 1] as (...a: unknown[]) => Promise<Text>;
    args[args.length - 1] = async (...a: unknown[]) => {
      if (name !== 'synapse_session_start') {
        ensureOwnSession();
        trackEdits();
      }
      const result = await handler(...a);
      sessionCalls++;
      writeCheckpoint();
      if (briefed) return result;
      briefed = true;
      if (name === 'synapse_project_context' || CLIENTS_SHOWING_INSTRUCTIONS.has(clientName()) || result.isError) return result;
      return { ...result, content: [{ type: 'text', text: `Synapse brief (first call this session; current code wins):\n\n${brief}\n\n---` }, ...result.content] };
    };
    return register(...args);
  }) as typeof server.registerTool;
  toolNameRegistry.set(server, names);
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    if (poller) clearInterval(poller);
    poller = undefined;
    try {
      endOwnSession();
    } catch {
      /* the database may already be closed */
    }
    previousOnClose?.();
  };

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
      const r = storeObservation(db, { ...args, projectId: project.id, sessionId: sessionId(), source: 'agent', rootPath: project.rootPath });
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
        rootPath: project.rootPath,
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
      // Keywords, plus meaning when embeddings are on (synapse embed); keyword-only otherwise.
      const hits = await hybridSearch(db, { ...a, projectId: global ? undefined : project.id, limit: a.limit ?? 10 });
      if (hits.length === 0) {
        const stats = projectStats(db, global ? undefined : project.id);
        const active = stats.byStatus.active ?? 0;
        return text(
          stats.total === 0
            ? 'No Synapse memories exist for this project yet (fresh project). Do not repeat the search this turn.'
            : `No memories matched "${a.query}". ${active} active of ${stats.total} total memories; try broader terms, status "all", or an empty query to browse.`,
        );
      }
      const changes = changesFor(project.rootPath, project.id, hits.map((h) => h.observation));
      return text(formatIndex(hits, { query: a.query, global, maxTokens: a.maxTokens, changes }));
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
      const changes = changesFor(project.rootPath, project.id, obs);
      return text(obs.map((o) => formatDetail(o, changes.get(o.id))).join('\n\n---\n\n'));
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
    async ({ task, maxTokens }) => {
      if (hooks || !ownSession) return text(buildProjectContext(db, project, task, { maxTokens }).text);
      recordGoal(db, project.id, ownSession, task);
      // A later call in a session that already did work (often after the agent's context was summarized) leads with its progress.
      if (sessionCalls > 0) writeCheckpoint(true);
      return text(buildProjectContext(db, project, task, { maxTokens, sessionId: sessionCalls > 0 ? ownSession : undefined }).text);
    },
  );

  server.registerTool(
    'synapse_session_start',
    {
      title: 'Start Session',
      description: 'Begin a tracked session; returns the previous handoff summaries. Optionally rebind to another project root.',
      inputSchema: { agent: z.string().optional(), projectRoot: z.string().optional() },
    },
    async ({ agent, projectRoot }) => {
      if (!hooks) endOwnSession();
      if (projectRoot) {
        project = detectProject(projectRoot);
        if (!hooks) tracker = new WorktreeTracker(project.rootPath);
      }
      const s = startSession(db, project.id, { agent: agent ?? (clientName() || undefined) });
      if (!hooks) adopt(s.id);
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
      const own = !hooks && ownSession ? getSession(db, ownSession) : undefined;
      const s = own ?? activeSession(db, project.id) ?? startSession(db, project.id);
      refreshSessionHashes(db, s.id, project.rootPath);
      endSession(db, s.id, summary);
      if (s.id === ownSession) {
        releaseServerSession(db, s.id);
        ownSession = undefined;
      }
      return text(`Session ${s.id} closed with handoff summary.`);
    },
  );

  server.registerTool(
    'synapse_feedback',
    {
      title: 'Memory Feedback',
      description:
        'Record whether a memory helped, was verified against current code (clears its "changed since" flag), conflicted with current code, ' +
        'was outdated (auto-resolves) or was corrected. Adjusts future ranking.',
      inputSchema: { id: z.number().int(), signal: z.enum(['helpful', 'verified', 'conflicted', 'outdated', 'corrected']), note: z.string().optional() },
    },
    async ({ id, signal, note }) => {
      const [o] = getObservations(db, [id]);
      if (!o) return fail(`Memory #${id} not found`);
      // Re-hashing only makes sense against this project's files.
      recordFeedback(db, id, signal, note, o.projectId === project.id ? project.rootPath : undefined);
      return text(`Recorded ${signal} feedback on #${id}.${signal === 'verified' ? ' Its file hashes now match current code.' : ''}`);
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
    'synapse_lt_propose',
    {
      title: 'Propose Long-term Memory',
      description:
        'Propose a reviewed long-term memory: something worth knowing in many future sessions, not a one-off note. ' +
        'Kinds: semantic (stable fact), procedural (how to do something), episodic (notable event). ' +
        'scope "user" makes it portable across all projects (use only for personal preferences the user stated). ' +
        'Pass fromMemoryId to promote an existing memory (it becomes the evidence). Proposals are not shown in briefs until approved.',
      inputSchema: {
        kind: z.enum(LT_KINDS),
        title: z.string().optional(),
        body: z.string().optional(),
        scope: z.enum(LT_SCOPES).optional(),
        applicability: z.string().optional().describe('When this applies, e.g. "when publishing a release"'),
        evidence: z.array(z.string()).optional().describe('Memory ids (#12), commits, files or quotes that back it'),
        fromMemoryId: z.number().int().optional(),
      },
    },
    async ({ kind, title, body, scope, applicability, evidence, fromMemoryId }) => {
      try {
        const r = fromMemoryId != null
          ? promoteToLongTerm(db, project.id, fromMemoryId, { kind, scope, applicability, proposedBy: 'agent' })
          : proposeLongTerm(db, { projectId: project.id, kind, title: title ?? '', body: body ?? '', scope, applicability, evidence, proposedBy: 'agent' });
        return text(`${r.action === 'exists' ? 'Already exists' : 'Proposed'}: ${ltLine(r.item)}\nIt reaches briefs once the user approves it (synapse_lt_approve asks them, or \`synapse lt approve ${r.item.id}\`).`);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'synapse_lt_approve',
    {
      title: 'Approve Long-term Memory',
      description:
        'Approve a proposed long-term memory so it reaches briefs; pass `supersedes` to retire an approved item it replaces. ' +
        'The user confirms every call in a permission prompt (Claude Code shows it in every permission mode), so call this only ' +
        'when you want the user to decide, and put their reason in `reason`.',
      inputSchema: {
        id: z.number().int(),
        reason: z.string().min(1),
        supersedes: z.number().int().optional().describe('An approved item this one replaces'),
      },
      // Claude Code prompts on every call to this tool in every permission mode; allow rules can't skip it.
      _meta: { [REQUIRES_USER]: true },
    },
    async ({ id, reason, supersedes }) => {
      try {
        const item = getLongTerm(db, project.id, id);
        if (!item) return fail(`Long-term item LT${id} not found`);
        const approved = item.state === 'approved' ? item : reviewLongTerm(db, project.id, id, 'approve', reason);
        if (supersedes != null) supersedeLongTerm(db, project.id, supersedes, id, reason);
        return text(`Approved: ${ltLine(approved)}${supersedes != null ? `\nLT${supersedes} superseded by LT${id}.` : ''}`);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'synapse_lt_archive',
    {
      title: 'Archive Long-term Memory',
      description: 'Archive a long-term memory: reject a proposal, or retire an approved item that is no longer true. A reason is required.',
      inputSchema: { id: z.number().int(), reason: z.string().min(1) },
    },
    async ({ id, reason }) => {
      try {
        return text(`Archived: ${ltLine(reviewLongTerm(db, project.id, id, 'archive', reason))}`);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'synapse_lt_list',
    {
      title: 'List Long-term Memory',
      description: 'List long-term memories visible in this project (its own plus user-scope), newest first. Filter by state or a full-text query.',
      inputSchema: {
        state: z.enum([...LT_STATES, 'all']).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ state, query, limit }) => {
      const items = listLongTerm(db, project.id, { state: state ?? 'approved', query, limit: limit ?? 20 });
      return text(items.length ? items.map((i) => `- ${ltLine(i)}`).join('\n') : 'No long-term memories match.');
    },
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
  // The agent closing stdin (or stopping the process) ends the session the server ran, with an automatic summary.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown);
}
