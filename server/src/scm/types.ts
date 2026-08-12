import type {
  DataAvailability,
  EvidenceConfidence,
  QualitySignal,
  SafeMetadata,
} from '../../../core/src/ledgerContracts.js';

export interface ScmRepositoryContext {
  repo: string;
  worktree?: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;
  pullRequestId?: string;
}

export type ScmProviderKind = 'git' | 'pull-request' | 'ci' | 'review';

/** A read-only provider binding. Missing `source` is an explicit unavailable provider. */
export interface ScmProviderBinding<T> {
  providerId: string;
  source?: T;
  unavailableReason?: string;
}

export interface GitStatusSnapshot {
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  metadata?: SafeMetadata;
}

export interface GitBranchSnapshot {
  name?: string;
  detached: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  metadata?: SafeMetadata;
}

export interface GitCommitSnapshot {
  sha: string;
  shortSha?: string;
  subject?: string;
  authorName?: string;
  committedAt?: number;
  metadata?: SafeMetadata;
}

/** Injected read-only Git boundary. It has no mutation methods by design. */
export interface ScmGitSource {
  getStatus(context: ScmRepositoryContext): Promise<GitStatusSnapshot>;
  getBranch(context: ScmRepositoryContext): Promise<GitBranchSnapshot>;
  getCommit(context: ScmRepositoryContext): Promise<GitCommitSnapshot>;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface PullRequestSnapshot {
  id: string;
  state: PullRequestState;
  title?: string;
  draft?: boolean;
  headBranch?: string;
  baseBranch?: string;
  url?: string;
  updatedAt?: number;
  metadata?: SafeMetadata;
}

export type CheckStatus = 'queued' | 'in_progress' | 'completed';
export type CheckConclusion =
  'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';

export interface CiCheckSnapshot {
  id: string;
  name: string;
  status: CheckStatus;
  conclusion?: CheckConclusion;
  url?: string;
  completedAt?: number;
  metadata?: SafeMetadata;
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';

export interface ReviewSnapshot {
  id: string;
  reviewer?: string;
  state: ReviewState;
  submittedAt?: number;
  url?: string;
  metadata?: SafeMetadata;
}

/** Each provider is optional so one missing integration does not hide Git facts. */
export interface ScmPullRequestSource {
  getPullRequest(context: ScmRepositoryContext): Promise<PullRequestSnapshot | undefined>;
}

export interface ScmCiSource {
  getChecks(context: ScmRepositoryContext): Promise<CiCheckSnapshot[]>;
}

export interface ScmReviewSource {
  getReviews(context: ScmRepositoryContext): Promise<ReviewSnapshot[]>;
}

export interface ScmProviderWiring {
  git?: ScmProviderBinding<ScmGitSource>;
  pullRequest?: ScmProviderBinding<ScmPullRequestSource>;
  ci?: ScmProviderBinding<ScmCiSource>;
  review?: ScmProviderBinding<ScmReviewSource>;
}

export interface ScmQualitySources {
  pullRequest?: ScmPullRequestSource;
  ci?: ScmCiSource;
  review?: ScmReviewSource;
}

export interface ScmProviderStatus {
  kind: ScmProviderKind;
  providerId: string;
  availability: DataAvailability;
  reason?: string;
}

export interface ScmObservation<T> {
  availability: DataAvailability;
  confidence: EvidenceConfidence;
  capturedAt: number;
  value?: T;
  reason?: string;
}

export interface ScmEvidenceSnapshot {
  context: ScmRepositoryContext;
  capturedAt: number;
  providers: ScmProviderStatus[];
  git: {
    status: ScmObservation<GitStatusSnapshot>;
    branch: ScmObservation<GitBranchSnapshot>;
    commit: ScmObservation<GitCommitSnapshot>;
  };
  quality: {
    pullRequest: ScmObservation<PullRequestSnapshot | undefined>;
    ci: ScmObservation<CiCheckSnapshot[]>;
    review: ScmObservation<ReviewSnapshot[]>;
  };
  qualitySignals: QualitySignal[];
  metadata: SafeMetadata;
}
