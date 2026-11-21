/**
 * Git memory: turn commits into source-backed observations.
 */
import { gitText } from './gitexec.js';
import type { DB } from './db.js';
import { storeObservation } from './store.js';
import type { ObservationType } from './types.js';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

function runGit(cwd: string, args: string[]): string {
  return gitText(cwd, args);
}

const SEP = '\u001e';
const FIELD = '\u001f';

export function getRecentCommits(cwd: string, count = 20, since?: string): CommitInfo[] {
  const args = ['log', `-n${Math.max(1, Math.min(500, count))}`, '--no-color', `--pretty=format:${SEP}%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}`, '--numstat'];
  if (since) args.push(`--since=${since}`);
  let out: string;
  try {
    out = runGit(cwd, args);
  } catch {
    return [];
  }
  return out
    .split(SEP)
    .filter((c) => c.trim())
    .map((chunk) => {
      const [hash, shortHash, author, date, subject, body, stats = ''] = chunk.split(FIELD);
      const files: string[] = [];
      let ins = 0;
      let del = 0;
      for (const line of stats.split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        ins += m[1] === '-' ? 0 : Number(m[1]);
        del += m[2] === '-' ? 0 : Number(m[2]);
        files.push(m[3]);
      }
      return { hash, shortHash, author, date, subject: subject.trim(), body: body.trim(), filesChanged: files, insertions: ins, deletions: del };
    });
}

export function inferType(subject: string, body: string): ObservationType {
  const prefix = subject.match(/^(\w+)[\s(:!]/)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, ObservationType> = {
    fix: 'problem-solution', bugfix: 'problem-solution', hotfix: 'problem-solution', revert: 'problem-solution',
    feat: 'what-changed', feature: 'what-changed', refactor: 'what-changed', chore: 'what-changed', ci: 'what-changed', build: 'what-changed',
    docs: 'how-it-works', doc: 'how-it-works', test: 'discovery', security: 'gotcha', deprecate: 'decision', perf: 'trade-off',
  };
  if (map[prefix]) return map[prefix];
  const t = `${subject} ${body}`.toLowerCase();
  if (/\b(fix|bug|crash|error|hotfix|patch|revert|rollback)\b/.test(t)) return 'problem-solution';
  if (/\b(security|vulnerability|cve)\b/.test(t)) return 'gotcha';
  if (/\b(deprecat\w*|remove|drop)\b/.test(t)) return 'decision';
  if (/\b(perf|optimi[sz]\w*|speed|cache)\b/.test(t)) return 'trade-off';
  if (/\b(doc|readme)\b/.test(t)) return 'how-it-works';
  return 'what-changed';
}

const NOISE_FILES = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$/, /\.min\.(js|css)$/, /(^|\/)dist\//, /\.map$/];

export function isNoiseCommit(c: CommitInfo): { noise: boolean; reason?: string } {
  if (/^Merge (branch|pull request|remote-tracking)/i.test(c.subject)) return { noise: true, reason: 'merge' };
  if (/^(chore(\(release\))?:\s*)?(bump|release)?\s*v?\d+\.\d+\.\d+\S*$/i.test(c.subject)) return { noise: true, reason: 'version-bump' };
  if (/^(wip|tmp|temp|fixup!|squash!)/i.test(c.subject)) return { noise: true, reason: 'wip' };
  if (c.filesChanged.length > 0 && c.filesChanged.every((f) => NOISE_FILES.some((p) => p.test(f)))) return { noise: true, reason: 'generated-files-only' };
  return { noise: false };
}

const BULK_COMMIT_FILES = 40;

/** Most common meaningful directory among changed files (skips src/ and dot-dirs). */
export function dominantDir(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length < 2) continue;
    const dir = parts[0] === 'src' && parts.length > 2 ? parts[1] : parts[0];
    if (dir.startsWith('.')) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'project';
}

export interface IngestSummary {
  ingested: number;
  skippedExisting: number;
  skippedNoise: number;
  ids: number[];
}

export function ingestCommits(db: DB, projectId: string, cwd: string, opts: { count?: number; since?: string } = {}): IngestSummary {
  const commits = getRecentCommits(cwd, opts.count ?? 20, opts.since);
  const summary: IngestSummary = { ingested: 0, skippedExisting: 0, skippedNoise: 0, ids: [] };
  const exists = db.prepare('SELECT 1 FROM observations WHERE projectId = ? AND commitHash = ? LIMIT 1');
  for (const c of commits.reverse()) {
    if (exists.get(projectId, c.hash)) {
      summary.skippedExisting++;
      continue;
    }
    if (isNoiseCommit(c).noise) {
      summary.skippedNoise++;
      continue;
    }
    const scope = c.subject.match(/^\w+\(([^)]+)\)/)?.[1];
    // Bulk commits (imports, shallow-clone roots, mass reformat) carry no useful file signal.
    const bulk = c.filesChanged.length > BULK_COMMIT_FILES;
    const entityName = scope ?? (bulk ? 'project' : dominantDir(c.filesChanged));
    const narrative = [c.subject, c.body, `(${c.filesChanged.length} files, +${c.insertions}/-${c.deletions}, by ${c.author})`]
      .filter(Boolean)
      .join('\n\n');
    const res = storeObservation(db, {
      projectId,
      entityName,
      type: inferType(c.subject, c.body),
      title: c.subject.slice(0, 120),
      narrative,
      facts: [`Commit ${c.shortHash} on ${c.date.slice(0, 10)}`, ...(bulk ? [`Bulk commit touching ${c.filesChanged.length} files`] : [])],
      filesModified: bulk ? [] : c.filesChanged,
      concepts: scope ? [scope] : [],
      source: 'git',
      commitHash: c.hash,
      topicKey: `git/${c.hash}`,
    });
    summary.ingested++;
    summary.ids.push(res.observation.id);
  }
  return summary;
}
