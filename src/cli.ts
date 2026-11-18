#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`synapse requires Node.js >= 22.13 (built-in node:sqlite); found ${process.version}\n`);
  process.exit(process.argv[2] === 'hook' ? 0 : 1);
}

const HELP = `synapse — local-first project memory for AI coding agents

Usage: synapse <command> [options]

  serve [--mode lite|full]        Start the stdio MCP server
  hook [--agent A] [--event E]    Handle an agent hook event (JSON on stdin); A: claude|cursor|codex|devin|copilot|gemini|antigravity
  context [--task "..."]          Print the task-lensed project brief
  search <query> [--global] [--limit N] [--type T]
  store --type T --entity E --title "..." --narrative "..." [--topic K] [--facts a,b] [--files a,b]
  detail <id...>                  Show full memories
  timeline <id>                   Show memories around an id
  resolve <id...> [--status resolved|archived|active]
  stale [--limit N]               Memories whose files changed since they were stored
  verify <id...>                  Mark memories checked against current code (re-records file hashes)
  ingest-git [--count N] [--since DATE]
  session start|end [--summary "..."]
  checkpoint [list] [--session ID] [--limit N] | checkpoint show <id>
                                  Compaction checkpoints, newest first
  lt list [--state proposed|approved|archived|superseded] [--query Q]
  lt show <id>
  lt add --kind semantic|procedural|episodic --title "..." --text "..." [--scope project|user]
         [--applies "when ..."] [--evidence a,b] [--approve --reason "..."]
  lt promote <memory-id> --kind K [--scope S] [--approve --reason "..."]
  lt approve|archive <id> --reason "..."
  lt supersede <old-id> <new-id> --reason "..."
                                  Reviewed long-term memory (only approved items reach briefs)
  retention [--archive]           Memory health and archiving
  stats | projects                Counts for this project / all projects
  export [--out FILE]             Export this project's memories as JSON
  import <file> [--project ID]    Import an export bundle
  setup <claude|cursor|codex|devin|copilot|gemini|antigravity> [--global] [--dry-run] [--allow-tools (devin)] [--no-instructions]
                                  Register the MCP server + hooks, and add memory instructions to CLAUDE.md / AGENTS.md / GEMINI.md
  setup git [--dry-run]           Install a git post-commit hook that records each commit as a memory (any agent)
  instructions                    Print the memory instructions setup adds (for a global CLAUDE.md / AGENTS.md)
  ui [--port N] [--open]          Browse and curate memory in a local web page
  consolidate [--dry-run]         Merge ended sessions' auto-captured edit records per area; archive older duplicate command records
  doctor                          Diagnose environment
  doctor agents [--agent A] [--global] [--fix]
                                  Check each agent's hooks, MCP entry, instructions and the git hook; --fix repairs them
  uninstall [--agent A] [--global] [--dry-run]
                                  Remove what setup installed (memories are kept)

Env: SYNAPSE_HOME (default ~/.synapse), SYNAPSE_DB, SYNAPSE_MODE, SYNAPSE_HOOK_INJECT=full|minimal|silent
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: v, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      mode: { type: 'string' }, task: { type: 'string' }, global: { type: 'boolean' }, limit: { type: 'string' },
      type: { type: 'string' }, entity: { type: 'string' }, title: { type: 'string' }, narrative: { type: 'string' },
      topic: { type: 'string' }, facts: { type: 'string' }, files: { type: 'string' }, status: { type: 'string' },
      count: { type: 'string' }, since: { type: 'string' }, summary: { type: 'string' }, archive: { type: 'boolean' },
      out: { type: 'string' }, session: { type: 'string' }, kind: { type: 'string' }, scope: { type: 'string' }, text: { type: 'string' },
      applies: { type: 'string' }, evidence: { type: 'string' }, reason: { type: 'string' }, state: { type: 'string' }, query: { type: 'string' },
      approve: { type: 'boolean' }, project: { type: 'string' }, 'dry-run': { type: 'boolean' }, agent: { type: 'string' }, event: { type: 'string' }, fix: { type: 'boolean' }, port: { type: 'string' }, open: { type: 'boolean' }, 'allow-tools': { type: 'boolean' }, 'no-instructions': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  const list = (k: string) => str(k)?.split(',').map((s) => s.trim()).filter(Boolean);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || v.help) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === 'version') {
    const { VERSION } = await import('./config.js');
    console.log(VERSION);
    return;
  }

  if (cmd === 'serve') {
    const { serveStdio } = await import('./server.js');
    const { toolMode } = await import('./config.js');
    await serveStdio(toolMode(str('mode')));
    return;
  }

  if (cmd === 'hook') {
    try {
      const { readStdin, handleHook } = await import('./hooks.js');
      const { formatHookResult, normalizeHookPayload, resolveAgent } = await import('./agents.js');
      const { getDb } = await import('./db.js');
      const raw = await readStdin();
      if (!raw.trim()) return;
      const payload = JSON.parse(raw);
      // Copilot's camelCase payloads carry no event name; setup passes it as --event.
      if (!payload.hook_event_name && str('event')) payload.hook_event_name = str('event');
      const agent = resolveAgent(str('agent'), payload);
      let context: string | undefined;
      let continueWith: string | undefined;
      for (const input of normalizeHookPayload(agent, payload)) {
        const r = handleHook(getDb(), input);
        context = r.context ?? context;
        continueWith = r.continueWith ?? continueWith;
      }
      const out = formatHookResult(agent, String(payload.hook_event_name ?? ''), { context, continueWith });
      if (out) process.stdout.write(out);
    } catch (e) {
      if (process.env.SYNAPSE_DEBUG) process.stderr.write(`[synapse hook] ${(e as Error).stack}\n`);
    }
    return;
  }

  if (cmd === 'setup') return setup(pos[0], Boolean(v.global), Boolean(v['dry-run']), Boolean(v['allow-tools']), !v['no-instructions']);
  if (cmd === 'instructions') {
    const { SYNAPSE_INSTRUCTIONS } = await import('./setup.js');
    console.log(SYNAPSE_INSTRUCTIONS);
    return;
  }
  if (cmd === 'doctor' && pos[0] === 'agents') return doctorAgentsCmd(str('agent'), Boolean(v.global), Boolean(v.fix));
  if (cmd === 'doctor') return doctor();
  if (cmd === 'uninstall') return uninstallCmd(str('agent'), Boolean(v.global), Boolean(v['dry-run']));
  if (cmd === 'ui') {
    const { getDb } = await import('./db.js');
    const { detectProject } = await import('./project.js');
    const { startUi } = await import('./ui.js');
    const port = str('port') ? Number(str('port')) : 0;
    const { url } = await startUi({ db: getDb(), project: detectProject(process.cwd()), port });
    console.log(`Synapse UI: ${url}`);
    console.log('Local only (127.0.0.1); the link carries this run\'s access token. Ctrl+C to stop.');
    if (v.open) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try { execFileSync(opener, [url], { stdio: 'ignore' }); } catch { /* print only */ }
    }
    return;
  }

  const { getDb } = await import('./db.js');
  const { detectProject } = await import('./project.js');
  const db = getDb();
  const project = detectProject(process.cwd());
  const store = await import('./store.js');
  const disc = await import('./disclosure.js');

  switch (cmd) {
    case 'consolidate': {
      const { consolidateProject } = await import('./consolidate.js');
      const dryRun = Boolean(v['dry-run']);
      const results = consolidateProject(db, project, { dryRun });
      const merged = results.flatMap((r) => r.merged);
      const archived = results.flatMap((r) => r.archived);
      console.log(`synapse consolidate${dryRun ? ' (dry run)' : ''}: ${project.id}`);
      for (const r of results) {
        for (const m of r.merged) console.log(`  ${dryRun ? 'would merge' : 'merged'} ${m.from.length} edit record${m.from.length === 1 ? '' : 's'} in ${m.entity}${m.into ? ` into #${m.into}` : ''} (${m.files.length} files, session ${r.sessionId.slice(0, 8)})`);
      }
      if (archived.length) console.log(`  ${dryRun ? 'would archive' : 'archived'} ${archived.length} older duplicate command record${archived.length === 1 ? '' : 's'}`);
      if (!merged.length && !archived.length) console.log('  nothing to consolidate');
      break;
    }
    case 'context': {
      const { buildProjectContext } = await import('./context.js');
      console.log(buildProjectContext(db, project, str('task') ?? pos.join(' ')).text);
      break;
    }
    case 'search': {
      const { search } = await import('./search.js');
      const hits = search(db, {
        query: pos.join(' '),
        projectId: v.global ? undefined : project.id,
        limit: Number(str('limit') ?? 10),
        type: list('type') as never,
        status: (str('status') as never) ?? 'active',
      });
      const { changesFor } = await import('./freshness.js');
      const changes = changesFor(project.rootPath, project.id, hits.map((h) => h.observation));
      console.log(hits.length ? disc.formatIndex(hits, { query: pos.join(' '), global: Boolean(v.global), changes }) : 'No matching memories.');
      break;
    }
    case 'store': {
      const { OBSERVATION_TYPES } = await import('./types.js');
      const type = str('type') ?? 'discovery';
      if (!(OBSERVATION_TYPES as readonly string[]).includes(type)) throw new Error(`--type must be one of ${OBSERVATION_TYPES.join(', ')}`);
      if (!str('title')) throw new Error('--title is required');
      const r = store.storeObservation(db, {
        projectId: project.id,
        entityName: str('entity') ?? 'project',
        type: type as never,
        title: str('title')!,
        narrative: str('narrative') ?? '',
        facts: list('facts'),
        filesModified: list('files'),
        topicKey: str('topic'),
        source: 'manual',
        rootPath: project.rootPath,
      });
      console.log(`${r.action}: ${disc.indexLine(r.observation)}`);
      break;
    }
    case 'detail': {
      const { changesFor } = await import('./freshness.js');
      const obs = store.getObservations(db, pos.map(Number));
      const changes = changesFor(project.rootPath, project.id, obs);
      console.log(obs.length ? obs.map((o) => disc.formatDetail(o, changes.get(o.id))).join('\n\n---\n\n') : 'Not found.');
      break;
    }
    case 'stale': {
      const { staleMemories } = await import('./freshness.js');
      const stale = staleMemories(db, project, Number(str('limit') ?? 50));
      console.log(stale.length
        ? [`Memories whose files changed since they were stored (${stale.length}):`, ...stale.map((x) => disc.indexLine(x.observation, x.changes)),
          '', 'Check each against current code, then: synapse verify <id> (still true) or synapse resolve <id> (outdated).'].join('\n')
        : 'No memory has files that changed since it was stored.');
      break;
    }
    case 'verify': {
      const ids = pos.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) throw new Error('verify needs memory ids');
      const own = store.getObservations(db, ids).filter((o) => o.projectId === project.id);
      for (const o of own) store.recordFeedback(db, o.id, 'verified', undefined, project.rootPath);
      console.log(`Verified ${own.length} memor${own.length === 1 ? 'y' : 'ies'}${own.length < ids.length ? ' (others not found in this project)' : ''}.`);
      break;
    }
    case 'timeline':
      console.log(disc.formatTimeline(store.timeline(db, Number(pos[0]))));
      break;
    case 'resolve': {
      const n = store.setStatus(db, pos.map(Number), (str('status') as never) ?? 'resolved', project.id);
      console.log(`Updated ${n}.`);
      break;
    }
    case 'ingest-git': {
      const { ingestCommits } = await import('./git.js');
      const r = ingestCommits(db, project.id, project.rootPath, { count: Number(str('count') ?? 20), since: str('since') });
      console.log(`Ingested ${r.ingested} (skipped ${r.skippedExisting} existing, ${r.skippedNoise} noise).`);
      break;
    }
    case 'session': {
      const s = await import('./sessions.js');
      if (pos[0] === 'start') console.log(s.startSession(db, project.id, { agent: 'cli' }).id);
      else if (pos[0] === 'end') {
        const a = s.activeSession(db, project.id);
        if (!a) console.log('No active session.');
        else console.log(`Closed ${s.endSession(db, a.id, str('summary'))?.id}`);
      } else console.log(s.recentSessions(db, project.id, 10, false).map((x) => `${x.startedAt.slice(0, 16)} ${x.status} ${x.agent ?? ''} ${x.summary ?? ''}`).join('\n') || 'No sessions.');
      break;
    }
    case 'checkpoint':
    case 'checkpoints': {
      const s = await import('./sessions.js');
      const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');
      if (pos[0] === 'show') {
        const c = s.getCheckpoint(db, Number(pos[1]));
        if (!c || c.projectId !== project.id) {
          console.log('Not found.');
          break;
        }
        console.log(`Checkpoint #${c.id} — session ${c.sessionId} — ${when(c.createdAt)}`);
        if (c.summary) console.log(`\nSynapse summary:\n${c.summary}`);
        if (c.agentSummary) console.log(`\nAgent summary:\n${c.agentSummary}`);
        break;
      }
      const rows = s.listCheckpoints(db, project.id, { sessionId: str('session'), limit: Number(str('limit') ?? 20) });
      console.log(rows.map((c) => `#${c.id}  ${when(c.createdAt)}  ${c.sessionId.slice(0, 8)}  ${s.checkpointText(c).slice(0, 160)}`).join('\n') || 'No checkpoints.');
      break;
    }
    case 'lt': {
      const lt = await import('./longterm.js');
      const sub = pos[0] ?? 'list';
      const id = Number(pos[1]);
      const reason = str('reason') ?? '';
      const kind = (str('kind') ?? 'semantic') as never;
      const scope = (str('scope') ?? 'project') as never;
      if (sub === 'list') {
        const state = (str('state') ?? 'all') as never;
        const items = lt.listLongTerm(db, project.id, { state, query: str('query'), limit: Number(str('limit') ?? 50) });
        console.log(items.map((i) => lt.ltLine(i, 120)).join('\n') || 'No long-term memories.');
      } else if (sub === 'show') {
        const i = lt.getLongTerm(db, project.id, id);
        console.log(i ? lt.ltDetail(i) : 'Not found.');
      } else if (sub === 'add' || sub === 'promote') {
        const r = sub === 'promote'
          ? lt.promoteToLongTerm(db, project.id, id, { kind, scope, applicability: str('applies'), proposedBy: 'manual' })
          : lt.proposeLongTerm(db, {
            projectId: project.id, kind, scope, title: str('title') ?? '', body: str('text') ?? '',
            applicability: str('applies'), evidence: list('evidence'), proposedBy: 'manual',
          });
        // A person at the CLI is the reviewer: --approve with --reason approves in one step.
        const item = v.approve && r.action === 'proposed' ? lt.reviewLongTerm(db, project.id, r.item.id, 'approve', reason) : r.item;
        console.log(`${r.action === 'exists' ? 'exists' : item.state}: ${lt.ltLine(item)}`);
      } else if (sub === 'approve' || sub === 'archive') {
        console.log(`${sub === 'approve' ? 'approved' : 'archived'}: ${lt.ltLine(lt.reviewLongTerm(db, project.id, id, sub, reason))}`);
      } else if (sub === 'supersede') {
        lt.supersedeLongTerm(db, project.id, id, Number(pos[2]), reason);
        console.log(`LT${id} superseded by LT${pos[2]}.`);
      } else {
        throw new Error('usage: synapse lt list|show|add|promote|approve|archive|supersede (see synapse help)');
      }
      break;
    }
    case 'retention': {
      const m = await import('./maintenance.js');
      const rep = m.retentionReport(db, project.id);
      console.log(`Zones: active ${rep.zones.active}, stale ${rep.zones.stale}, archive-candidate ${rep.zones['archive-candidate']}`);
      if (v.archive) console.log(`Archived ${m.archiveExpired(db, project.id).length}.`);
      break;
    }
    case 'stats':
      console.log(`Project: ${project.id} (${project.rootPath})`);
      console.log(JSON.stringify(store.projectStats(db, project.id), null, 2));
      break;
    case 'projects':
      for (const p of store.listProjects(db)) console.log(`${p.projectId}\t${p.count}\t${p.lastActivity}`);
      break;
    case 'export': {
      const { exportProject } = await import('./maintenance.js');
      const out = JSON.stringify(exportProject(db, project.id), null, 2);
      if (str('out')) writeFileSync(str('out')!, out);
      else console.log(out);
      break;
    }
    case 'import': {
      const { importBundle } = await import('./maintenance.js');
      const r = importBundle(db, JSON.parse(readFileSync(pos[0], 'utf8')), str('project') ?? project.id);
      console.log(`Imported ${r.imported}, merged ${r.merged}.`);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function setup(agent: string | undefined, global: boolean, dryRun: boolean, allowTools = false, instructions = true): Promise<void> {
  const { AGENTS, isAgentId } = await import('./agents.js');
  if (!isAgentId(agent) && agent !== 'git') {
    console.error(`Usage: synapse setup <${AGENTS.join('|')}|git> [--global] [--dry-run]`);
    process.exitCode = 1;
    return;
  }
  const { runSetup, setupGit } = await import('./setup.js');
  const run = agent === 'git' ? (o: Parameters<typeof runSetup>[1]) => setupGit(o) : (o: Parameters<typeof runSetup>[1]) => runSetup(agent, o);
  const report = run({
    global,
    dryRun,
    cwd: process.cwd(),
    home: os.homedir(),
    node: process.execPath,
    script: fileURLToPath(import.meta.url),
    useAgentCli: true,
    allowTools,
    instructions,
  });
  console.log(`synapse setup ${agent}${global ? ' --global' : ''}${dryRun ? ' (dry run)' : ''}`);
  for (const c of report.changes) console.log(`  • ${c}`);
  for (const n of report.notes) console.log(`  → ${n}`);
}

function setupOptions(global: boolean, dryRun = false) {
  return { global, dryRun, cwd: process.cwd(), home: os.homedir(), node: process.execPath, script: fileURLToPath(import.meta.url), useAgentCli: true };
}

async function agentArg(agent: string | undefined, usage: string) {
  const { isAgentId } = await import('./agents.js');
  if (agent === undefined || isAgentId(agent) || agent === 'git') return { ok: true as const, agent };
  console.error(usage);
  process.exitCode = 1;
  return { ok: false as const };
}

async function doctorAgentsCmd(agentFlag: string | undefined, global: boolean, fix: boolean): Promise<void> {
  const a = await agentArg(agentFlag, 'Usage: synapse doctor agents [--agent A] [--global] [--fix]');
  if (!a.ok) return;
  const { doctorAgents, repairAgents } = await import('./doctor.js');
  const o = setupOptions(global);
  const icon = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: '--  ' } as const;
  const print = (health: ReturnType<typeof doctorAgents>) => {
    const installed = health.filter((h) => h.installed);
    for (const h of installed) {
      console.log(`${h.agent}`);
      for (const c of h.checks) console.log(`  ${icon[c.status]} ${c.what}: ${c.detail}`);
    }
    const absent = health.filter((h) => !h.installed).map((h) => h.agent);
    if (absent.length) console.log(`not set up${global ? ' globally' : ' here'}: ${absent.join(', ')}`);
    return installed.flatMap((h) => h.checks).filter((c) => c.status === 'fail' || c.status === 'warn').length;
  };
  console.log(`synapse doctor agents${global ? ' --global' : ` (${o.cwd})`}`);
  let health = doctorAgents(o, a.agent as never);
  const problems = print(health);
  if (!problems) return;
  if (!fix) {
    console.log(`\n${problems} problem${problems === 1 ? '' : 's'}. Run "synapse doctor agents --fix${global ? ' --global' : ''}" to repair (it re-runs setup for those agents).`);
    process.exitCode = 1;
    return;
  }
  console.log('\nRepairing:');
  for (const r of repairAgents(o, health)) {
    console.log(`  ${r.agent}`);
    for (const c of r.changes) console.log(`    • ${c}`);
  }
  console.log('\nAfter repair:');
  health = doctorAgents(o, a.agent as never);
  if (print(health)) process.exitCode = 1;
}

async function uninstallCmd(agentFlag: string | undefined, global: boolean, dryRun: boolean): Promise<void> {
  const a = await agentArg(agentFlag, 'Usage: synapse uninstall [--agent A] [--global] [--dry-run]');
  if (!a.ok) return;
  const { uninstall } = await import('./doctor.js');
  const { databasePath } = await import('./config.js');
  console.log(`synapse uninstall${a.agent ? ` --agent ${a.agent}` : ''}${global ? ' --global' : ''}${dryRun ? ' (dry run)' : ''}`);
  const reports = uninstall(setupOptions(global, dryRun), a.agent as never);
  if (reports.length === 0) console.log('  nothing of Synapse\'s found in this scope');
  for (const r of reports) {
    console.log(`  ${r.agent}`);
    for (const c of r.changes) console.log(`    • ${c}`);
    for (const n of r.notes) console.log(`    → ${n}`);
  }
  if (a.agent && a.agent !== 'git') console.log('  Instruction blocks are shared between agents and were left in place; "synapse uninstall" without --agent removes them.');
  console.log(`  Your memories are kept in ${databasePath()}. Delete that file to remove them too.`);
}

async function doctor(): Promise<void> {
  const { databasePath } = await import('./config.js');
  const ok = (b: boolean) => (b ? 'ok ' : 'FAIL');
  console.log(`${ok(true)} node ${process.version} (${process.execPath})`);
  try {
    const { openDatabase } = await import('./db.js');
    const db = openDatabase(':memory:');
    db.prepare("SELECT * FROM observations_fts WHERE observations_fts MATCH 'x'").all();
    console.log(`${ok(true)} node:sqlite + FTS5`);
  } catch (e) {
    console.log(`${ok(false)} node:sqlite/FTS5: ${(e as Error).message}`);
  }
  console.log(`     database: ${databasePath()} ${existsSync(databasePath()) ? '' : '(not created yet)'}`);
  const { detectProject } = await import('./project.js');
  const p = detectProject(process.cwd());
  console.log(`${ok(true)} project: ${p.id} @ ${p.rootPath}`);
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    console.log(`${ok(true)} git available`);
  } catch {
    console.log(`${ok(false)} git not found (git memory disabled)`);
  }
}

main().catch((e) => {
  process.stderr.write(`synapse: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
