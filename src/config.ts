import os from 'node:os';
import path from 'node:path';

/** Root directory for all Synapse state. Override with SYNAPSE_HOME. */
export function synapseHome(): string {
  return process.env.SYNAPSE_HOME || path.join(os.homedir(), '.synapse');
}

export function databasePath(): string {
  return process.env.SYNAPSE_DB || path.join(synapseHome(), 'synapse.db');
}

export type ToolMode = 'lite' | 'full';

export function toolMode(explicit?: string): ToolMode {
  const v = (explicit || process.env.SYNAPSE_MODE || 'lite').toLowerCase();
  return v === 'full' ? 'full' : 'lite';
}

/** Hook injection: full = task brief on SessionStart, minimal = one-line hint, silent = nothing. */
export function hookInjectMode(): 'full' | 'minimal' | 'silent' {
  const v = (process.env.SYNAPSE_HOOK_INJECT || 'full').toLowerCase();
  return v === 'minimal' || v === 'silent' ? v : 'full';
}

/**
 * SYNAPSE_HOOKS=1 tells the MCP server that lifecycle hooks are installed for its agent (setup sets it).
 * Hooks then own the brief and the session; without them, the server does that work itself.
 */
export function hooksInstalled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SYNAPSE_HOOKS ?? '');
}

export const VERSION = '0.1.0';
