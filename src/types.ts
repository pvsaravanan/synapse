/**
 * Synapse core types.
 */

export const OBSERVATION_TYPES = [
  'session-request',
  'gotcha',
  'problem-solution',
  'how-it-works',
  'what-changed',
  'discovery',
  'why-it-exists',
  'decision',
  'trade-off',
  'reasoning',
] as const;

export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const TYPE_LABEL: Record<ObservationType, string> = {
  'session-request': 'SESSION',
  gotcha: 'GOTCHA',
  'problem-solution': 'FIX',
  'how-it-works': 'INFO',
  'what-changed': 'CHANGE',
  discovery: 'DISCOVERY',
  'why-it-exists': 'WHY',
  decision: 'DECISION',
  'trade-off': 'TRADEOFF',
  reasoning: 'REASONING',
};

export type ObservationStatus = 'active' | 'resolved' | 'archived';
export type ObservationSource = 'agent' | 'git' | 'manual' | 'hook' | 'team';
/** qualified = eligible for automatic delivery; candidate = auto-captured, searchable but down-ranked. */
export type AdmissionState = 'candidate' | 'qualified';
export type ValueCategory = 'core' | 'contextual' | 'ephemeral';

export interface Progress {
  feature: string;
  status: 'in-progress' | 'completed' | 'blocked';
  completion?: number;
}

export interface Observation {
  id: number;
  projectId: string;
  entityName: string;
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  filesModified: string[];
  concepts: string[];
  tokens: number;
  createdAt: string;
  updatedAt?: string;
  topicKey?: string;
  revisionCount: number;
  sessionId?: string;
  status: ObservationStatus;
  supersededBy?: number;
  progress?: Progress;
  source: ObservationSource;
  commitHash?: string;
  relatedCommits: string[];
  relatedEntities: string[];
  admissionState: AdmissionState;
  valueCategory?: ValueCategory;
  hasCausalLanguage: boolean;
  /** Content hash of each named file when the memory was stored (project-relative path -> hash; '' = absent). */
  fileHashes: Record<string, string>;
  /** Stable id once shared through the repo's team memory file. */
  uid?: string;
  /** The feature branch this memory belongs to until that branch merges; undefined = project-wide. */
  branch?: string;
}

export interface StoreInput {
  projectId: string;
  entityName: string;
  type: ObservationType;
  title: string;
  narrative: string;
  facts?: string[];
  filesModified?: string[];
  concepts?: string[];
  topicKey?: string;
  sessionId?: string;
  progress?: Progress;
  source?: ObservationSource;
  commitHash?: string;
  relatedCommits?: string[];
  relatedEntities?: string[];
  admissionState?: AdmissionState;
  valueCategory?: ValueCategory;
  /** Project root: when given, the named files are hashed so later changes flag the memory as possibly outdated. */
  rootPath?: string;
  /**
   * 'branch' (default): on a feature branch, the memory belongs to that branch until it merges. 'project': it holds
   * on every branch. Needs rootPath to know the branch.
   */
  scope?: 'branch' | 'project';
}

export type StoreAction = 'created' | 'updated-topic' | 'merged-duplicate';

export interface StoreResult {
  observation: Observation;
  action: StoreAction;
  /** On a feature branch: why the memory belongs to the branch or holds project-wide (branch.ts scopeFor). */
  scopeReason?: string;
}

export interface Session {
  id: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed';
  summary?: string;
  agent?: string;
}

/** A snapshot of session state taken at context compaction; one row per compaction, never overwritten. */
export interface Checkpoint {
  id: number;
  sessionId: string;
  projectId: string;
  createdAt: string;
  /** Synapse's structured summary (goal, files touched, stored memories). */
  summary?: string;
  /** The agent's own compaction summary, when it provides one (Devin PostCompaction). */
  agentSummary?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  gitRemote?: string;
}

export interface SemanticScores {
  sims: Map<number, number>;
  cut: number;
}

export interface SearchOptions {
  query: string;
  /** Omit for global (cross-project) search. */
  projectId?: string;
  type?: ObservationType | ObservationType[];
  status?: ObservationStatus | 'all';
  limit?: number;
  since?: string;
  entityName?: string;
  /** Optional token budget for the compact index. */
  maxTokens?: number;
  /** Visible on this branch (string), project-wide only (null), or every branch (undefined). */
  branch?: string | null;
  /**
   * From embed.ts: the query's cosine similarity to each embedded memory, and the cut above which a memory counts as
   * related. Related memories gain score (and join the results); keyword matches the model calls unrelated lose some.
   */
  semantic?: SemanticScores;
}

export interface SearchHit {
  observation: Observation;
  score: number;
  lexical: number;
  relevance: number;
  /** Cosine similarity to the query when embeddings are on. */
  semantic?: number;
}

/** verified = checked against current code and still true (also re-records its file hashes). */
export type FeedbackSignal = 'helpful' | 'verified' | 'conflicted' | 'outdated' | 'corrected';
