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
export type ObservationSource = 'agent' | 'git' | 'manual' | 'hook';
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
}

export type StoreAction = 'created' | 'updated-topic' | 'merged-duplicate';

export interface StoreResult {
  observation: Observation;
  action: StoreAction;
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

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  gitRemote?: string;
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
}

export interface SearchHit {
  observation: Observation;
  score: number;
  lexical: number;
  relevance: number;
}

export type FeedbackSignal = 'helpful' | 'conflicted' | 'outdated' | 'corrected';
