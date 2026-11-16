/**
 * Per-agent hook adapters. Each agent's hook payload is normalized into the
 * Claude-style HookInput that hooks.ts understands, and the result is
 * formatted back into the response shape that agent expects.
 *
 *   claude  Claude Code  — native format
 *   codex   Codex        — Claude-compatible events/fields; edits arrive as `apply_patch`
 *   cursor  Cursor       — camelCase events, `conversation_id`, `workspace_roots`
 *   devin   Devin CLI    — Claude-style events, lowercase tools (`exec`, `edit`, …), no `cwd`
 *                          (DEVIN_PROJECT_DIR instead); also imports Claude Code's hooks
 */
import type { HookInput } from './hooks.js';

export const AGENTS = ['claude', 'cursor', 'codex', 'devin'] as const;
export type AgentId = (typeof AGENTS)[number];

export const AGENT_LABEL: Record<AgentId, string> = { claude: 'claude-code', cursor: 'cursor', codex: 'codex', devin: 'devin' };

type Raw = Record<string, unknown>;

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENTS as readonly string[]).includes(v);
}

/** Best-effort detection when no --agent flag was given. Codex and Claude share a format, so Claude is the default. */
export function detectAgent(raw: Raw, env: NodeJS.ProcessEnv = process.env): AgentId {
  if ('cursor_version' in raw || 'conversation_id' in raw || 'workspace_roots' in raw) return 'cursor';
  if (env.DEVIN_PROJECT_DIR) return 'devin';
  return 'claude';
}

/**
 * Final agent for a hook run. Devin CLI imports Claude Code's hooks, which run
 * `synapse hook` with Claude settings; DEVIN_PROJECT_DIR (set by Devin for every
 * hook, never by Claude Code) identifies those runs as Devin.
 */
export function resolveAgent(flag: unknown, raw: Raw, env: NodeJS.ProcessEnv = process.env): AgentId {
  const agent = isAgentId(flag) ? flag : detectAgent(raw, env);
  return agent === 'claude' && env.DEVIN_PROJECT_DIR ? 'devin' : agent;
}

const CURSOR_EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart',
  beforeSubmitPrompt: 'UserPromptSubmit',
  afterFileEdit: 'PostToolUse',
  afterShellExecution: 'PostToolUse',
  preCompact: 'PreCompact',
  sessionEnd: 'SessionEnd',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function normalizeCursor(raw: Raw): HookInput[] {
  const rawEvent = str(raw.hook_event_name) ?? '';
  const event = CURSOR_EVENTS[rawEvent];
  if (!event) return [];
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((r): r is string => typeof r === 'string') : [];
  const base: HookInput = {
    agent: 'cursor',
    hook_event_name: event,
    session_id: str(raw.conversation_id) ?? str(raw.session_id),
    cwd: roots[0] ?? str(raw.cwd),
  };
  switch (rawEvent) {
    case 'beforeSubmitPrompt':
      return [{ ...base, prompt: str(raw.prompt) ?? '' }];
    case 'afterFileEdit': {
      const edits = Array.isArray(raw.edits) ? (raw.edits as { new_string?: unknown }[]) : [];
      const newText = edits.map((e) => (typeof e?.new_string === 'string' ? e.new_string : '')).filter(Boolean).join('\n');
      return [{ ...base, tool_name: 'Edit', tool_input: { file_path: str(raw.file_path) ?? '', new_string: newText } }];
    }
    case 'afterShellExecution':
      return [{ ...base, tool_name: 'Bash', tool_input: { command: str(raw.command) ?? '' }, tool_response: raw.output }];
    default:
      return [base];
  }
}

/** Collect every string inside a value (apply_patch input shapes vary: string, {input}, {command: [...]}, ...). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

export interface PatchFile {
  path: string;
  op: 'add' | 'update' | 'delete';
  added: string;
}

/** Parse the files touched by a Codex `*** Begin Patch` envelope, with the lines each one adds. */
export function parseApplyPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of text.split('\n')) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = { path: header[2].trim(), op: header[1].toLowerCase() as PatchFile['op'], added: '' };
      files.push(current);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move && current) {
      current.path = move[1].trim();
      continue;
    }
    if (current && line.startsWith('+') && !line.startsWith('+++')) current.added += line.slice(1) + '\n';
  }
  return files;
}

function normalizeCodex(raw: Raw): HookInput[] {
  const input = { ...(raw as HookInput), agent: 'codex' as const };
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'apply_patch') {
    const patch = strings(raw.tool_input).find((s) => s.includes('*** Begin Patch')) ?? strings(raw.tool_input).join('\n');
    return parseApplyPatch(patch)
      .filter((f) => f.op !== 'delete')
      .map((f) => ({ ...input, tool_name: f.op === 'add' ? 'Write' : 'Edit', tool_input: { file_path: f.path, new_string: f.added.trimEnd() } }));
  }
  return [input];
}

// ── Devin CLI ────────────────────────────────────────────────────────────

const DEVIN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostCompaction', 'SessionEnd']);

/** First non-empty string among candidate keys (Devin does not document edit-tool fields). */
function pick(o: Raw, keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  return undefined;
}

const PATH_KEYS = ['file_path', 'path', 'filePath', 'filepath', 'target_file', 'file', 'notebook_path'];
const CONTENT_KEYS = ['new_string', 'new_str', 'newString', 'content', 'new_content', 'new_source', 'text', 'replacement'];

function normalizeDevin(raw: Raw, env: NodeJS.ProcessEnv): HookInput[] {
  const event = str(raw.hook_event_name) ?? '';
  if (!DEVIN_EVENTS.has(event)) return [];
  const base: HookInput = {
    agent: 'devin',
    hook_event_name: event === 'PostCompaction' ? 'PreCompact' : event,
    session_id: str(raw.session_id),
    cwd: str(raw.cwd) ?? env.DEVIN_PROJECT_DIR,
    source: str(raw.source),
    prompt: str(raw.prompt),
    summary: str(raw.summary),
  };
  if (event !== 'PostToolUse') return [base];

  const tool = str(raw.tool_name) ?? '';
  const input = (raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {}) as Raw;
  switch (tool) {
    case 'exec':
      return [{ ...base, tool_name: 'Bash', tool_input: { command: pick(input, ['command', 'cmd']) ?? '' }, tool_response: raw.tool_response }];
    case 'edit':
    case 'write':
    case 'notebook_edit': {
      const file = pick(input, PATH_KEYS);
      if (!file) return [];
      const edits = Array.isArray(input.edits) ? (input.edits as Raw[]).map((e) => pick(e ?? {}, CONTENT_KEYS) ?? '').filter(Boolean).join('\n') : '';
      const content = pick(input, CONTENT_KEYS) ?? edits;
      return [{ ...base, tool_name: tool === 'write' ? 'Write' : 'Edit', tool_input: { file_path: file, new_string: content } }];
    }
    case 'apply_patch': {
      const patch = strings(input).find((s) => s.includes('*** Begin Patch')) ?? strings(input).join('\n');
      return parseApplyPatch(patch)
        .filter((f) => f.op !== 'delete')
        .map((f) => ({ ...base, tool_name: f.op === 'add' ? 'Write' : 'Edit', tool_input: { file_path: f.path, new_string: f.added.trimEnd() } }));
    }
    default:
      // Reads, searches, MCP calls (incl. Synapse's own), process control: nothing to capture.
      return [];
  }
}

export function normalizeHookPayload(agent: AgentId, raw: Raw, env: NodeJS.ProcessEnv = process.env): HookInput[] {
  if (agent === 'cursor') return normalizeCursor(raw);
  if (agent === 'codex') return normalizeCodex(raw);
  if (agent === 'devin') return normalizeDevin(raw, env);
  return [{ ...(raw as HookInput), agent: 'claude' }];
}

/** Agent-specific stdout for a hook result (undefined = print nothing). */
export function formatHookResult(agent: AgentId, rawEvent: string, result: { context?: string }): string | undefined {
  if (agent === 'cursor') {
    if (rawEvent === 'sessionStart' && result.context) return JSON.stringify({ additional_context: result.context });
    if (rawEvent === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
    return undefined;
  }
  // Claude Code, Codex and Devin CLI share the hookSpecificOutput contract.
  if (rawEvent === 'SessionStart' && result.context) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.context } });
  }
  return undefined;
}
