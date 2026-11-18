/**
 * `.synapseignore`: project files Synapse never captures as edits or hashes for file freshness. Gitignore-style
 * patterns at the project root; built-in defaults keep secret files out unless the project re-includes them.
 *
 *   # comment          blank lines and comments are skipped
 *   dist/              a trailing slash matches a directory and everything under it
 *   /build             a leading slash (or any inner slash) anchors to the project root
 *   *.log              otherwise a pattern matches the file name at any depth
 *   **, *, ?           any path, any characters except "/", one character
 *   !.env.example      negation re-includes; the last matching pattern wins
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const IGNORE_FILE = '.synapseignore';

/** Secret-shaped files, ignored unless `.synapseignore` re-includes them. */
export const DEFAULT_IGNORES = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc'];

interface Rule {
  negate: boolean;
  re: RegExp;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories; a bare "**" matches anything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

export function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    const body = globToRegex(line);
    // A directory rule matches only paths under that directory; any other rule also matches a named directory's contents.
    const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dirOnly ? '/.*' : '(?:/.*)?'}$`);
    rules.push({ negate, re });
  }
  return rules;
}

/** Is a project-relative path (posix separators) ignored by these rules? The last matching rule wins. */
export function matches(rules: Rule[], rel: string): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.re.test(rel)) ignored = !r.negate;
  }
  return ignored;
}

const cache = new Map<string, { mtimeMs: number; rules: Rule[] }>();
const DEFAULT_RULES = parseIgnore(DEFAULT_IGNORES.join('\n'));

/** The project's rules: the defaults, then `.synapseignore` (re-read when it changes). */
export function ignoreRules(root: string): Rule[] {
  const file = path.join(root, IGNORE_FILE);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return DEFAULT_RULES;
  }
  const hit = cache.get(root);
  if (hit && hit.mtimeMs === mtimeMs) return hit.rules;
  let rules = DEFAULT_RULES;
  try {
    rules = [...DEFAULT_RULES, ...parseIgnore(readFileSync(file, 'utf8'))];
  } catch {
    /* unreadable: defaults only */
  }
  cache.set(root, { mtimeMs, rules });
  return rules;
}

export function isIgnored(root: string, rel: string): boolean {
  return matches(ignoreRules(root), rel.split(path.sep).join('/'));
}
