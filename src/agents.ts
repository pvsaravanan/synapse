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
 *   copilot GitHub Copilot CLI — camelCase events and fields, no event name in the payload (setup passes
 *                          `--event`); tools `bash`, `edit`, `create`, or `apply_patch` (GPT models, verified
 *                          on 1.0.114); `toolArgs` is an object, or the raw patch text for `apply_patch`
 *   gemini  Gemini CLI   — snake_case fields; `BeforeAgent`, `AfterTool`, `PreCompress`; tools
 *                          `write_file`, `replace`, `run_shell_command`
 */
import type { HookInput } from './hooks.js';

export const AGENTS = ['claude', 'cursor', 'codex', 'devin', 'copilot', 'gemini'] as const;
export type AgentId = (typeof AGENTS)[number];

export const AGENT_LABEL: Record<AgentId, string> = { claude: 'claude-code', cursor: 'cursor', codex: 'codex', devin: 'devin', copilot: 'copilot', gemini: 'gemini' };

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

/** One Claude-style Write/Edit per file an `apply_patch` call adds or updates (Codex, Devin, Copilot with GPT models). */
function patchEdits(base: HookInput, toolInput: unknown): HookInput[] {
  const patch = strings(toolInput).find((s) => s.includes('*** Begin Patch')) ?? strings(toolInput).join('\n');
  return parseApplyPatch(patch)
    .filter((f) => f.op !== 'delete')
    .map((f) => ({ ...base, tool_name: f.op === 'add' ? 'Write' : 'Edit', tool_input: { file_path: f.path, new_string: f.added.trimEnd() } }));
}

function normalizeCodex(raw: Raw): HookInput[] {
  const input = { ...(raw as HookInput), agent: 'codex' as const };
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'apply_patch') return patchEdits(input, raw.tool_input);
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
const CONTENT_KEYS = ['new_string', 'new_str', 'newString', 'content', 'file_text', 'new_content', 'new_source', 'text', 'replacement'];

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
    case 'apply_patch':
      return patchEdits(base, input);
    default:
      // Reads, searches, MCP calls (incl. Synapse's own), process control: nothing to capture.
      return [];
  }
}

/** An edit or write tool's call as a Claude-style Edit/Write, or nothing when it names no file. */
function fileEdit(base: HookInput, kind: 'Edit' | 'Write', input: Raw): HookInput[] {
  const file = pick(input, PATH_KEYS);
  if (!file) return [];
  return [{ ...base, tool_name: kind, tool_input: { file_path: file, new_string: pick(input, CONTENT_KEYS) ?? '' } }];
}

// ── GitHub Copilot CLI ───────────────────────────────────────────────────

/** camelCase event names (native payload) and the PascalCase ones (snake_case, Claude-compatible payload). */
const COPILOT_EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart', SessionStart: 'SessionStart',
  userPromptSubmitted: 'UserPromptSubmit', UserPromptSubmit: 'UserPromptSubmit',
  postToolUse: 'PostToolUse', PostToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUse', PostToolUseFailure: 'PostToolUse',
  preCompact: 'PreCompact', PreCompact: 'PreCompact',
  sessionEnd: 'SessionEnd', SessionEnd: 'SessionEnd',
};

function objectArgs(v: unknown): Raw {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Raw) : {};
}

function normalizeCopilot(raw: Raw): HookInput[] {
  const rawEvent = str(raw.hook_event_name) ?? '';
  const event = COPILOT_EVENTS[rawEvent];
  if (!event) return [];
  const base: HookInput = {
    agent: 'copilot',
    hook_event_name: event,
    session_id: str(raw.sessionId) ?? str(raw.session_id),
    cwd: str(raw.cwd),
    source: str(raw.source),
    prompt: str(raw.prompt),
  };
  if (event !== 'PostToolUse') return [base];

  const tool = str(raw.toolName) ?? str(raw.tool_name) ?? '';
  const args = raw.toolArgs ?? raw.tool_input;
  const input = objectArgs(args);
  switch (tool) {
    case 'bash':
    case 'Bash': {
      const result = objectArgs(raw.toolResult ?? raw.tool_result);
      const resultType = str(result.resultType) ?? str(result.result_type);
      const output = [str(result.textResultForLlm) ?? str(result.text_result_for_llm), str(raw.error)].filter(Boolean).join('\n');
      // A failing command still reports resultType "success"; its output ends "<shellId: 0 completed with exit code N>".
      const code = output.match(/(?:completed|exited) with exit code (-?\d+)/i);
      const failed = /Failure$/.test(rawEvent) || (resultType !== undefined && resultType !== 'success');
      const status = code ? { exit_code: Number(code[1]) } : failed ? { success: false } : {};
      return [{ ...base, tool_name: 'Bash', tool_input: { command: pick(input, ['command', 'cmd']) ?? '' }, tool_response: { output, ...status } }];
    }
    case 'apply_patch':
      return patchEdits(base, args);
    case 'edit':
    case 'str_replace':
    case 'Edit':
      return fileEdit(base, 'Edit', input);
    case 'create':
    case 'write':
    case 'Write':
      return fileEdit(base, 'Write', input);
    default:
      return [];
  }
}

// ── Gemini CLI ───────────────────────────────────────────────────────────

const GEMINI_EVENTS: Record<string, string> = {
  SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', AfterTool: 'PostToolUse', PreCompress: 'PreCompact', SessionEnd: 'SessionEnd',
};

function normalizeGemini(raw: Raw): HookInput[] {
  const event = GEMINI_EVENTS[str(raw.hook_event_name) ?? ''];
  if (!event) return [];
  const base: HookInput = { agent: 'gemini', hook_event_name: event, session_id: str(raw.session_id), cwd: str(raw.cwd), source: str(raw.source), prompt: str(raw.prompt) };
  if (event !== 'PostToolUse') return [base];

  const input = objectArgs(raw.tool_input);
  switch (str(raw.tool_name)) {
    case 'run_shell_command': {
      const r = objectArgs(raw.tool_response);
      const output = strings(r.llmContent ?? r.returnDisplay ?? '').join('\n');
      const code = output.match(/Exit Code: (-?\d+)/i);
      const error = r.error ? strings(r.error).join('\n') || 'error' : undefined;
      return [{
        ...base, tool_name: 'Bash', tool_input: { command: pick(input, ['command']) ?? '' },
        tool_response: { output: [output, error].filter(Boolean).join('\n'), ...(code ? { exit_code: Number(code[1]) } : error ? { success: false } : {}) },
      }];
    }
    case 'replace':
    case 'edit':
    case 'smart_edit':
      return fileEdit(base, 'Edit', input);
    case 'write_file':
      return fileEdit(base, 'Write', input);
    default:
      return [];
  }
}

export function normalizeHookPayload(agent: AgentId, raw: Raw, env: NodeJS.ProcessEnv = process.env): HookInput[] {
  if (agent === 'cursor') return normalizeCursor(raw);
  if (agent === 'codex') return normalizeCodex(raw);
  if (agent === 'devin') return normalizeDevin(raw, env);
  if (agent === 'copilot') return normalizeCopilot(raw);
  if (agent === 'gemini') return normalizeGemini(raw);
  return [{ ...(raw as HookInput), agent: 'claude' }];
}

/** Agent-specific stdout for a hook result (undefined = print nothing). */
export function formatHookResult(agent: AgentId, rawEvent: string, result: { context?: string }): string | undefined {
  if (agent === 'cursor') {
    if (rawEvent === 'sessionStart' && result.context) return JSON.stringify({ additional_context: result.context });
    if (rawEvent === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
    return undefined;
  }
  if (agent === 'copilot' && rawEvent === 'sessionStart') return result.context ? JSON.stringify({ additionalContext: result.context }) : undefined;
  // Claude Code, Codex, Devin CLI, Gemini CLI and Copilot's PascalCase hooks share the hookSpecificOutput contract.
  if (rawEvent === 'SessionStart' && result.context) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.context } });
  }
  return undefined;
}
