/**
 * Claude Code hook handler (`synapse hook`), reading the hook JSON on stdin.
 *
 *   SessionStart     -> inject a task brief as additionalContext
 *   UserPromptSubmit -> record the session's first substantial prompt as its goal (candidate)
 *   PostToolUse      -> capture file edits / significant commands as candidate memories
 *   PreCompact       -> checkpoint an auto-summary onto the session
 *   SessionEnd       -> close the session with an auto-summary
 *
 * Auto-captured records are 'candidate' + 'ephemeral': searchable but
 * down-ranked, never surfaced as cautions, and decay twice as fast.
 * A hook must never break the host, so every failure exits 0 silently.
 */
import path from 'node:path';
import { hookInjectMode } from './config.js';
import { buildProjectContext } from './context.js';
import type { DB } from './db.js';
import { detectProject } from './project.js';
import { endSession, getSession, startSession } from './sessions.js';
import { listObservations, storeObservation } from './store.js';
import type { ObservationType, ProjectInfo } from './types.js';

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

export interface HookOutput {
  stdout?: string;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch', 'Skill']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TRIVIAL_CMD = /^(ls|ll|la|cd|pwd|echo|cat|head|tail|less|more|which|whoami|clear|date|env|printenv|history|true|false|tree|wc|file|stat|open)\b/;
const TRIVIAL_GIT = /^git\s+(status|log|diff|show|branch|remote|fetch|stash list|rev-parse|config --get)\b/;
const SIGNIFICANT_CMD = /\b(test|vitest|jest|pytest|cargo|go (test|build)|make|tsc|build|lint|eslint|migrate|deploy|docker|kubectl|terraform|npm (run|install|i|ci)|pnpm|yarn|pip install|brew install)\b/;
const ERROR_TEXT = /\b(error|failed|failure|exception|traceback|panic|cannot|not found|ENOENT|EACCES|segmentation fault)\b/i;

export function isTrivialCommand(cmd: string): boolean {
  const c = cmd.trim().replace(/^(sudo|time|env \S+=\S+)\s+/, '');
  return c.length < 4 || TRIVIAL_CMD.test(c) || TRIVIAL_GIT.test(c);
}

function stringify(v: unknown, max = 600): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function relPath(project: ProjectInfo, file: string): string {
  const abs = path.resolve(file);
  const rel = path.relative(project.rootPath, abs);
  return rel.startsWith('..') ? abs : rel;
}

function entityForFile(rel: string): string {
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return 'project';
  return parts[0] === 'src' && parts.length > 2 ? parts[1] : parts[0];
}

function autoSummary(db: DB, project: ProjectInfo, sessionId: string): string | undefined {
  const obs = listObservations(db, { projectId: project.id, limit: 500, status: 'all' }).filter((o) => o.sessionId === sessionId);
  if (obs.length === 0) return undefined;
  const goal = obs.find((o) => o.type === 'session-request');
  const files = [...new Set(obs.flatMap((o) => o.filesModified))];
  const explicit = obs.filter((o) => o.source !== 'hook');
  const parts: string[] = [];
  if (goal) parts.push(`Goal: ${goal.title}`);
  if (files.length) parts.push(`Touched ${files.length} file(s): ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`);
  if (explicit.length) parts.push(`Stored: ${explicit.slice(0, 5).map((o) => `#${o.id} ${o.title}`).join('; ')}`);
  return parts.join('. ') || undefined;
}

export function handleHook(db: DB, input: HookInput): HookOutput {
  const event = input.hook_event_name ?? '';
  const project = detectProject(input.cwd || process.cwd());
  const sessionId = input.session_id;
  if (sessionId) startSession(db, project.id, { id: sessionId, agent: 'claude-code' });

  switch (event) {
    case 'SessionStart': {
      const mode = hookInjectMode();
      if (mode === 'silent') return {};
      const hint = 'Synapse memory is available: use synapse_search / synapse_project_context for prior decisions, gotchas and fixes; synapse_store to save durable learnings.';
      let context = hint;
      if (mode === 'full') {
        const brief = buildProjectContext(db, project, input.source === 'compact' ? 'continue the current task after compaction' : 'continue work on this project', { maxTokens: 700 });
        context = `${hint}\n\n${brief.text}`;
      }
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) };
    }

    case 'UserPromptSubmit': {
      const prompt = (input.prompt ?? '').trim();
      if (!sessionId || prompt.length < 20 || prompt.startsWith('/')) return {};
      const hasGoal = listObservations(db, { projectId: project.id, type: ['session-request'], limit: 20, status: 'all' }).some((o) => o.sessionId === sessionId);
      if (hasGoal) return {};
      storeObservation(db, {
        projectId: project.id,
        entityName: 'session',
        type: 'session-request',
        title: prompt.split('\n')[0].slice(0, 100),
        narrative: prompt.slice(0, 1500),
        sessionId,
        source: 'hook',
        admissionState: 'candidate',
        valueCategory: 'ephemeral',
        topicKey: `hook/goal/${sessionId}`,
      });
      return {};
    }

    case 'PostToolUse': {
      const tool = input.tool_name ?? '';
      if (!tool || READ_ONLY_TOOLS.has(tool) || /^mcp__.*synapse/i.test(tool)) return {};
      const ti = input.tool_input ?? {};

      if (EDIT_TOOLS.has(tool)) {
        const file = String(ti.file_path ?? ti.notebook_path ?? '');
        if (!file) return {};
        const rel = relPath(project, file);
        const snippet = stringify(ti.new_string ?? ti.content ?? ti.new_source ?? (Array.isArray(ti.edits) ? ti.edits.map((e: { new_string?: string }) => e.new_string).join('\n') : ''), 400);
        storeObservation(db, {
          projectId: project.id,
          entityName: entityForFile(rel),
          type: 'what-changed',
          title: `${tool === 'Write' ? 'Wrote' : 'Edited'} ${rel}`,
          narrative: snippet ? `Latest change excerpt:\n${snippet}` : `${tool} on ${rel}`,
          filesModified: [rel],
          sessionId,
          source: 'hook',
          admissionState: 'candidate',
          valueCategory: 'ephemeral',
          // One rolling record per file per session instead of one per edit.
          topicKey: `hook/file/${rel}/${sessionId ?? 'nosession'}`,
        });
        return {};
      }

      if (tool === 'Bash') {
        const cmd = String(ti.command ?? '').trim();
        if (!cmd || isTrivialCommand(cmd)) return {};
        const out = stringify(input.tool_response, 800);
        const failed = ERROR_TEXT.test(out);
        if (!SIGNIFICANT_CMD.test(cmd) && !failed) return {};
        const type: ObservationType = failed ? 'gotcha' : 'discovery';
        const short = cmd.split('\n')[0].slice(0, 80);
        storeObservation(db, {
          projectId: project.id,
          entityName: 'commands',
          type,
          title: `${failed ? 'Command failed' : 'Ran'}: ${short}`,
          narrative: `$ ${cmd.slice(0, 500)}\n\n${out}`,
          concepts: [cmd.split(/\s+/)[0]],
          sessionId,
          source: 'hook',
          admissionState: 'candidate',
          valueCategory: 'ephemeral',
          topicKey: `hook/cmd/${short}/${sessionId ?? 'nosession'}`,
        });
      }
      return {};
    }

    case 'PreCompact': {
      if (sessionId) {
        const s = autoSummary(db, project, sessionId);
        if (s) db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(s, sessionId);
      }
      return {};
    }

    case 'SessionEnd': {
      if (sessionId && getSession(db, sessionId)?.status === 'active') {
        endSession(db, sessionId, autoSummary(db, project, sessionId));
      }
      return {};
    }

    default:
      return {};
  }
}

export async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
