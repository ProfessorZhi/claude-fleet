import type {
  QualitySignal,
  SafeMetadata,
  SafeMetadataValue,
} from '../../../core/src/ledgerContracts.js';
import { normalizeSafeMetadata } from '../../../core/src/ledgerContracts.js';
import type {
  CiCheckSnapshot,
  GitBranchSnapshot,
  GitCommitSnapshot,
  GitStatusSnapshot,
  PullRequestSnapshot,
  ReviewSnapshot,
  ScmCiSource,
  ScmEvidenceSnapshot,
  ScmGitSource,
  ScmObservation,
  ScmProviderBinding,
  ScmProviderKind,
  ScmProviderStatus,
  ScmProviderWiring,
  ScmPullRequestSource,
  ScmQualitySources,
  ScmRepositoryContext,
  ScmReviewSource,
} from './types.js';

export interface ScmAdapterOptions {
  git?: ScmGitSource;
  quality?: ScmQualitySources;
  providers?: ScmProviderWiring;
  now?: () => number;
}

/**
 * Read-only SCM evidence boundary.
 *
 * The adapter only calls injected sources. It cannot commit, merge, push,
 * delete, read credentials, or receive a raw diff because those operations are
 * not part of the source contracts.
 */
export class ScmAdapter {
  readonly mode = 'read-only' as const;

  private readonly git?: ScmGitSource;
  private readonly gitBinding?: ScmProviderBinding<ScmGitSource>;
  private readonly qualityBindings: {
    pullRequest?: ScmProviderBinding<ScmPullRequestSource>;
    ci?: ScmProviderBinding<ScmCiSource>;
    review?: ScmProviderBinding<ScmReviewSource>;
  };
  private readonly providers: ScmProviderStatus[];
  private readonly now: () => number;

  constructor(options: ScmAdapterOptions = {}) {
    this.gitBinding = normalizeBinding(
      'git',
      options.providers?.git ??
        (options.git ? { providerId: 'legacy-git', source: options.git } : undefined),
    );
    this.git = this.gitBinding?.source;
    this.qualityBindings = {
      pullRequest: normalizeBinding(
        'pull-request',
        options.providers?.pullRequest ??
          (options.quality?.pullRequest
            ? { providerId: 'legacy-pull-request', source: options.quality.pullRequest }
            : undefined),
      ),
      ci: normalizeBinding(
        'ci',
        options.providers?.ci ??
          (options.quality?.ci
            ? { providerId: 'legacy-ci', source: options.quality.ci }
            : undefined),
      ),
      review: normalizeBinding(
        'review',
        options.providers?.review ??
          (options.quality?.review
            ? { providerId: 'legacy-review', source: options.quality.review }
            : undefined),
      ),
    };
    this.providers = [
      providerStatus('git', this.gitBinding),
      providerStatus('pull-request', this.qualityBindings.pullRequest),
      providerStatus('ci', this.qualityBindings.ci),
      providerStatus('review', this.qualityBindings.review),
    ];
    this.now = options.now ?? (() => Date.now());
  }

  async collect(context: ScmRepositoryContext): Promise<ScmEvidenceSnapshot> {
    const normalizedContext = normalizeContext(context);
    const capturedAt = this.now();

    const [status, branch, commit, pullRequest, ci, review] = await Promise.all([
      this.collectGit('status', normalizedContext, capturedAt, () =>
        this.git?.getStatus(normalizedContext),
      ),
      this.collectGit('branch', normalizedContext, capturedAt, () =>
        this.git?.getBranch(normalizedContext),
      ),
      this.collectGit('commit', normalizedContext, capturedAt, () =>
        this.git?.getCommit(normalizedContext),
      ),
      this.collectQuality(
        'pull-request',
        normalizedContext,
        capturedAt,
        this.qualityBindings.pullRequest,
        (source: ScmPullRequestSource) => source.getPullRequest(normalizedContext),
      ),
      this.collectQuality(
        'ci',
        normalizedContext,
        capturedAt,
        this.qualityBindings.ci,
        (source: ScmCiSource) => source.getChecks(normalizedContext),
      ),
      this.collectQuality(
        'review',
        normalizedContext,
        capturedAt,
        this.qualityBindings.review,
        (source: ScmReviewSource) => source.getReviews(normalizedContext),
      ),
    ]);

    const qualitySignals = projectQualitySignals(
      normalizedContext,
      { pullRequest, ci, review },
      capturedAt,
    );

    return {
      context: normalizedContext,
      capturedAt,
      providers: this.providers.map((provider) => ({ ...provider })),
      git: { status, branch, commit },
      quality: { pullRequest, ci, review },
      qualitySignals,
      metadata: buildMetadata(normalizedContext, { status, branch, commit }, qualitySignals),
    };
  }

  private async collectGit<T>(
    operation: string,
    _context: ScmRepositoryContext,
    capturedAt: number,
    call: () => Promise<T> | undefined,
  ): Promise<ScmObservation<T>> {
    if (!this.gitBinding?.source)
      return unavailableObservation(
        capturedAt,
        operation +
          ' provider ' +
          (this.gitBinding?.providerId ?? 'unconfigured') +
          ' is unavailable.',
      );
    try {
      const value = await call();
      return value === undefined
        ? unavailableObservation(capturedAt, operation + ' evidence is unavailable.')
        : {
            availability: 'available',
            confidence: 'exact',
            capturedAt,
            value: sanitizeGitValue(operation, value),
          };
    } catch (error) {
      return unavailableObservation(capturedAt, safeReason(operation, error));
    }
  }

  private async collectQuality<T, TSource>(
    operation: string,
    _context: ScmRepositoryContext,
    capturedAt: number,
    binding: ScmProviderBinding<TSource> | undefined,
    call: (source: TSource) => Promise<T>,
  ): Promise<ScmObservation<T>> {
    if (!binding?.source) {
      return unavailableObservation(
        capturedAt,
        operation +
          ' provider ' +
          (binding?.providerId ?? 'unconfigured') +
          ' is unavailable.' +
          (binding?.unavailableReason
            ? ' ' + safeReason(operation, binding.unavailableReason)
            : ''),
      );
    }
    try {
      const value = await call(binding.source);
      return {
        availability: 'available',
        confidence: 'high',
        capturedAt,
        value: sanitizeQualityValue(operation, value),
      };
    } catch (error) {
      return unavailableObservation(capturedAt, safeReason(operation, error));
    }
  }
}

function providerStatus<T>(
  kind: ScmProviderKind,
  binding: ScmProviderBinding<T> | undefined,
): ScmProviderStatus {
  if (binding?.source) {
    return { kind, providerId: binding.providerId, availability: 'available' };
  }
  return {
    kind,
    providerId: binding?.providerId ?? 'unconfigured',
    availability: 'unavailable',
    reason: binding?.unavailableReason
      ? safeReason(kind, binding.unavailableReason)
      : 'provider is unavailable.',
  };
}

function normalizeBinding<T>(
  kind: ScmProviderKind,
  binding: ScmProviderBinding<T> | undefined,
): ScmProviderBinding<T> | undefined {
  if (!binding) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.providerId)) {
    throw new Error(`${kind} providerId must be a safe identifier.`);
  }
  return {
    ...binding,
    providerId: binding.providerId,
    unavailableReason: binding.unavailableReason
      ? safeReason(kind, binding.unavailableReason)
      : undefined,
  };
}

export function projectQualitySignals(
  context: ScmRepositoryContext,
  quality: {
    pullRequest: ScmObservation<PullRequestSnapshot | undefined>;
    ci: ScmObservation<CiCheckSnapshot[]>;
    review: ScmObservation<ReviewSnapshot[]>;
  },
  capturedAt: number,
): QualitySignal[] {
  const signals: QualitySignal[] = [];
  signals.push(projectPullRequestSignal(context, quality.pullRequest, capturedAt));

  if (quality.ci.availability !== 'available') {
    signals.push(unavailableSignal(context, 'ci', quality.ci, capturedAt));
  } else {
    for (const check of quality.ci.value ?? []) {
      signals.push({
        ...signalIdentity(context, 'ci', check.id, quality.ci, capturedAt),
        outcome: conclusionOutcome(check.conclusion),
        summary: check.name,
        metadata: safeMetadata({
          checkId: check.id,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          url: check.url,
          completedAt: check.completedAt,
          ...check.metadata,
        }),
      });
    }
  }

  if (quality.review.availability !== 'available') {
    signals.push(unavailableSignal(context, 'review', quality.review, capturedAt));
  } else {
    for (const review of quality.review.value ?? []) {
      signals.push({
        ...signalIdentity(context, 'review', review.id, quality.review, capturedAt),
        outcome: reviewOutcome(review.state),
        summary: review.reviewer ? review.reviewer + ': ' + review.state : review.state,
        metadata: safeMetadata({
          reviewId: review.id,
          reviewer: review.reviewer,
          state: review.state,
          submittedAt: review.submittedAt,
          url: review.url,
          ...review.metadata,
        }),
      });
    }
  }

  return signals;
}

function projectPullRequestSignal(
  context: ScmRepositoryContext,
  observation: ScmObservation<PullRequestSnapshot | undefined>,
  capturedAt: number,
): QualitySignal {
  const pullRequest = observation.value;
  if (observation.availability !== 'available' || !pullRequest) {
    return unavailableSignal(context, 'pull-request', observation, capturedAt);
  }

  return {
    ...signalIdentity(context, 'pull-request', pullRequest.id, observation, capturedAt),
    pullRequestId: pullRequest.id,
    outcome:
      pullRequest.state === 'merged'
        ? 'passed'
        : pullRequest.state === 'closed'
          ? 'failed'
          : 'neutral',
    summary: pullRequest.title ?? 'Pull request ' + pullRequest.id,
    metadata: safeMetadata({
      pullRequestId: pullRequest.id,
      state: pullRequest.state,
      title: pullRequest.title,
      draft: pullRequest.draft,
      headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      url: pullRequest.url,
      updatedAt: pullRequest.updatedAt,
      ...pullRequest.metadata,
    }),
  };
}

function signalIdentity(
  context: ScmRepositoryContext,
  kind: QualitySignal['kind'],
  id: string,
  observation: ScmObservation<unknown>,
  capturedAt: number,
): Pick<
  QualitySignal,
  | 'signalId'
  | 'kind'
  | 'missionId'
  | 'workItemId'
  | 'instanceId'
  | 'capturedAt'
  | 'source'
  | 'availability'
  | 'confidence'
  | 'estimateOrActual'
> {
  return {
    signalId: 'scm-' + kind + '-' + stableId(context.repo + '-' + id),
    kind,
    missionId: context.missionId,
    workItemId: context.workItemId,
    instanceId: context.instanceId,
    capturedAt: observation.capturedAt || capturedAt,
    source: 'scm',
    availability: observation.availability,
    confidence: observation.confidence,
    estimateOrActual: 'actual',
  };
}

function unavailableSignal(
  context: ScmRepositoryContext,
  kind: 'pull-request' | 'ci' | 'review',
  observation: ScmObservation<unknown>,
  capturedAt: number,
): QualitySignal {
  return {
    ...signalIdentity(context, kind, 'unavailable', observation, capturedAt),
    outcome: 'neutral',
    summary: observation.reason ?? kind + ' evidence is unavailable.',
  };
}

function buildMetadata(
  context: ScmRepositoryContext,
  git: {
    status: ScmObservation<GitStatusSnapshot>;
    branch: ScmObservation<GitBranchSnapshot>;
    commit: ScmObservation<GitCommitSnapshot>;
  },
  signals: QualitySignal[],
): SafeMetadata {
  const status = git.status.value;
  const branch = git.branch.value;
  const commit = git.commit.value;
  return safeMetadata({
    repo: context.repo,
    worktree: context.worktree,
    branch: branch?.name,
    detached: branch?.detached,
    upstream: branch?.upstream,
    ahead: branch?.ahead,
    behind: branch?.behind,
    clean: status?.clean,
    stagedCount: status?.stagedCount,
    unstagedCount: status?.unstagedCount,
    untrackedCount: status?.untrackedCount,
    conflictedCount: status?.conflictedCount,
    commitSha: commit?.sha,
    shortSha: commit?.shortSha,
    commitSubject: commit?.subject,
    qualitySignalCount: signals.length,
    unavailableQualitySignals: signals.filter((signal) => signal.availability === 'unavailable')
      .length,
  });
}

function safeMetadata(input: unknown): SafeMetadata {
  return stripForbiddenScmKeys(normalizeSafeMetadata(input));
}

function sanitizeGitValue<T>(operation: string, value: T): T {
  const record = value as Record<string, unknown>;
  if (operation === 'status') {
    return {
      clean: record.clean === true,
      stagedCount: nonNegativeInteger(record.stagedCount),
      unstagedCount: nonNegativeInteger(record.unstagedCount),
      untrackedCount: nonNegativeInteger(record.untrackedCount),
      conflictedCount: nonNegativeInteger(record.conflictedCount),
      metadata: safeMetadata(record.metadata),
    } as T;
  }
  if (operation === 'branch') {
    return {
      name: textValue(record.name),
      detached: record.detached === true,
      upstream: textValue(record.upstream),
      ahead: nonNegativeIntegerOrUndefined(record.ahead),
      behind: nonNegativeIntegerOrUndefined(record.behind),
      metadata: safeMetadata(record.metadata),
    } as T;
  }
  return {
    sha: textValue(record.sha) ?? '',
    shortSha: textValue(record.shortSha),
    subject: textValue(record.subject),
    authorName: textValue(record.authorName),
    committedAt: nonNegativeNumberOrUndefined(record.committedAt),
    metadata: safeMetadata(record.metadata),
  } as T;
}

function sanitizeQualityValue<T>(operation: string, value: T): T {
  if (value === undefined) return value;
  if (operation === 'pull-request') {
    const record = value as Record<string, unknown>;
    return {
      id: textValue(record.id) ?? '',
      state: pullRequestState(record.state),
      title: textValue(record.title),
      draft: typeof record.draft === 'boolean' ? record.draft : undefined,
      headBranch: textValue(record.headBranch),
      baseBranch: textValue(record.baseBranch),
      url: textValue(record.url),
      updatedAt: nonNegativeNumberOrUndefined(record.updatedAt),
      metadata: safeMetadata(record.metadata),
    } as T;
  }
  if (!Array.isArray(value)) return [] as T;
  if (operation === 'ci') {
    return value.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: textValue(record.id) ?? '',
        name: textValue(record.name) ?? '',
        status: checkStatus(record.status),
        conclusion: checkConclusion(record.conclusion),
        url: textValue(record.url),
        completedAt: nonNegativeNumberOrUndefined(record.completedAt),
        metadata: safeMetadata(record.metadata),
      };
    }) as T;
  }
  return value.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      id: textValue(record.id) ?? '',
      reviewer: textValue(record.reviewer),
      state: reviewState(record.state),
      submittedAt: nonNegativeNumberOrUndefined(record.submittedAt),
      url: textValue(record.url),
      metadata: safeMetadata(record.metadata),
    };
  }) as T;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : undefined;
}

function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const number = nonNegativeNumberOrUndefined(value);
  return number !== undefined && Number.isInteger(number) ? number : 0;
}

function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
  const number = nonNegativeNumberOrUndefined(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function pullRequestState(value: unknown): PullRequestSnapshot['state'] {
  return value === 'merged' || value === 'closed' ? value : 'open';
}

function checkStatus(value: unknown): CiCheckSnapshot['status'] {
  return value === 'queued' || value === 'in_progress' ? value : 'completed';
}

function checkConclusion(value: unknown): CiCheckSnapshot['conclusion'] {
  return value === 'success' ||
    value === 'failure' ||
    value === 'neutral' ||
    value === 'cancelled' ||
    value === 'skipped' ||
    value === 'timed_out'
    ? value
    : undefined;
}

function reviewState(value: unknown): ReviewSnapshot['state'] {
  return value === 'approved' ||
    value === 'changes_requested' ||
    value === 'commented' ||
    value === 'pending' ||
    value === 'dismissed'
    ? value
    : 'pending';
}

function stripForbiddenScmKeys(value: SafeMetadata): SafeMetadata {
  const result: Record<string, SafeMetadataValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(?:diff|patch|raw|prompt|transcript|token|secret|credential|environment)/i.test(key)) {
      continue;
    }
    result[key] = stripForbiddenScmValue(child);
  }
  return result;
}

function stripForbiddenScmValue(value: SafeMetadataValue): SafeMetadataValue {
  if (Array.isArray(value)) return value.map((item) => stripForbiddenScmValue(item));
  if (typeof value === 'object' && value !== null) return stripForbiddenScmKeys(value);
  return value;
}

function unavailableObservation<T>(capturedAt: number, reason: string): ScmObservation<T> {
  return {
    availability: 'unavailable',
    confidence: 'unknown',
    capturedAt,
    reason,
  };
}

function conclusionOutcome(conclusion: CiCheckSnapshot['conclusion']): QualitySignal['outcome'] {
  if (conclusion === 'success') return 'passed';
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'failed';
  return 'neutral';
}

function reviewOutcome(state: ReviewSnapshot['state']): QualitySignal['outcome'] {
  if (state === 'approved') return 'passed';
  if (state === 'changes_requested') return 'failed';
  return 'neutral';
}

function normalizeContext(context: ScmRepositoryContext): ScmRepositoryContext {
  const repo = context.repo.trim();
  if (!repo) throw new Error('SCM evidence requires a non-empty repo.');
  return {
    ...context,
    repo,
    worktree: context.worktree?.trim() || undefined,
    missionId: context.missionId?.trim() || undefined,
    workItemId: context.workItemId?.trim() || undefined,
    instanceId: context.instanceId?.trim() || undefined,
    pullRequestId: context.pullRequestId?.trim() || undefined,
  };
}

function stableId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 160);
}

function safeReason(operation: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\b\s*[:=]\s*(?:Bearer\s+)?\S+/gi,
      '[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/(?:diff|patch|transcript|prompt)\b[\s\S]*/gi, '[omitted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 256);
  return operation + ' unavailable: ' + redacted;
}
