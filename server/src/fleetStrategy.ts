import type { FleetContextUsage } from '../../core/src/fleetTelemetry.js';
import type {
  AssignmentAction,
  LedgerMeasurement,
  ResourceMetrics,
} from '../../core/src/ledgerContracts.js';
import type { FleetInstance, FleetRuntime, WorkItem } from '../../core/src/runtimeContracts.js';
import {
  costValue,
  isDirectiveActive,
  normalizeResourceDirective,
  type StrategyAdapter,
  type StrategyCandidate,
  type StrategyConstraint,
  type StrategyFactor,
  type StrategyInput,
  type StrategyRecommendation,
} from '../../core/src/strategyContracts.js';

const STRATEGY_VERSION = 'strategy-v1';
const DEFAULT_RECOMMENDATION_TTL_MS = 5 * 60 * 1000;
const MAX_CONTEXT_RATIO = 0.98;

interface RankedCandidate {
  candidate: StrategyCandidate;
  score: number;
  expected?: LedgerMeasurement<ResourceMetrics>;
  factors: StrategyFactor[];
}

/**
 * Explainable, side-effect-free assignment strategy.
 *
 * The adapter ranks existing instances first and falls back to a supplied
 * launch template. It never spawns a process and never converts tokens into
 * quota or cost. Missing evidence lowers confidence instead of being guessed.
 */
export class FleetStrategyAdapter implements StrategyAdapter {
  readonly strategyVersion = STRATEGY_VERSION;

  recommend(input: StrategyInput): StrategyRecommendation {
    const candidates = input.candidates ?? [];
    const directive = normalizeResourceDirective(input.directive);
    const directiveActive = isDirectiveActive(directive, input.now);
    const factors: StrategyFactor[] = [];
    const constraints: StrategyConstraint[] = [];

    if (directive && !directiveActive) {
      constraints.push({
        key: 'directive_expired',
        blocking: false,
        detail: 'Resource directive is expired or not yet active and was ignored.',
      });
    }

    const ranked = candidates
      .map((candidate) =>
        this.rankCandidate(candidate, input, directiveActive ? directive : undefined, constraints),
      )
      .filter((entry): entry is RankedCandidate => entry !== undefined)
      .sort((left, right) => right.score - left.score);

    if (ranked.length > 0) {
      const selected = ranked[0];
      factors.push(...selected.factors);
      for (const alternative of ranked.slice(1, 4))
        factors.push(...alternative.factors.slice(0, 2));

      return this.buildRecommendation(input, {
        action: 'assign_existing',
        selectedInstanceId: selected.candidate.instance.instanceId,
        candidateInstanceIds: ranked.map((entry) => entry.candidate.instance.instanceId),
        alternatives: ranked.slice(1, 4).map((entry) => entry.candidate.instance.instanceId),
        expected: selected.expected,
        expectedQuota: this.expectedQuota(selected.expected),
        factors,
        constraints,
        directiveId: directiveActive ? directive?.directiveId : undefined,
        confidence: this.confidence(selected.expected, constraints, ranked.length),
      });
    }

    const launch = this.selectLaunchTemplate(
      input,
      directiveActive ? directive : undefined,
      constraints,
      factors,
    );
    if (launch) {
      factors.push({
        key: 'launch_new',
        impact: 'positive',
        score: 10,
        detail:
          'No eligible existing instance was available; a policy-compatible launch template is available.',
      });
      return this.buildRecommendation(input, {
        action: 'launch_new',
        candidateInstanceIds: candidates.map((candidate) => candidate.instance.instanceId),
        alternatives: [],
        proposedLaunchTemplate: launch,
        factors,
        constraints,
        directiveId: directiveActive ? directive?.directiveId : undefined,
        confidence: this.confidence(undefined, constraints, 0),
      });
    }

    const action: AssignmentAction = constraints.some((constraint) => constraint.blocking)
      ? 'defer'
      : 'escalate';
    factors.push({
      key: 'no_assignment',
      impact: 'blocking',
      detail:
        action === 'defer'
          ? 'Assignment is blocked by current policy or resource constraints.'
          : 'No candidate or launch template can be evaluated.',
    });
    return this.buildRecommendation(input, {
      action,
      candidateInstanceIds: candidates.map((candidate) => candidate.instance.instanceId),
      alternatives: [],
      factors,
      constraints,
      directiveId: directiveActive ? directive?.directiveId : undefined,
      confidence: 'low',
    });
  }

  private rankCandidate(
    candidate: StrategyCandidate,
    input: StrategyInput,
    directive: StrategyInput['directive'],
    constraints: StrategyConstraint[],
  ): RankedCandidate | undefined {
    const instance = candidate.instance;
    const factors: StrategyFactor[] = [];

    if (!this.runtimeAllowed(instance.runtime, input.workItem, input.policy.allowedRuntimeTypes)) {
      return undefined;
    }
    if (!this.roleAllowed(instance.role, input.workItem, input.policy.allowedRoles)) {
      return undefined;
    }
    if (
      input.policy.allowedRepositories &&
      instance.repo &&
      !input.policy.allowedRepositories.includes(instance.repo)
    ) {
      return undefined;
    }
    if (['stopped', 'error'].includes(instance.status)) return undefined;

    if (
      input.workItem.worktree &&
      instance.worktree === input.workItem.worktree &&
      instance.workItemId !== input.workItem.workItemId
    ) {
      constraints.push({
        key: 'worktree_conflict',
        blocking: true,
        detail: `Instance ${instance.instanceId} is already assigned to the same worktree by another WorkItem.`,
      });
      return undefined;
    }

    let score = 0;
    if (instance.status === 'idle') {
      score += 20;
      factors.push({
        key: 'idle_capacity',
        impact: 'positive',
        score: 20,
        detail: 'Instance is idle and available for assignment.',
      });
    } else if (instance.status === 'waiting') {
      score += 12;
      factors.push({
        key: 'waiting_capacity',
        impact: 'positive',
        score: 12,
        detail: 'Instance is waiting and may accept another bounded task.',
      });
    } else if (instance.status === 'starting') {
      score -= 8;
      factors.push({
        key: 'starting_load',
        impact: 'negative',
        score: -8,
        detail: 'Instance is still starting.',
      });
    } else {
      score -= 10;
      factors.push({
        key: 'active_load',
        impact: 'negative',
        score: -10,
        detail: 'Instance is already working.',
      });
    }

    const contextRatio = this.contextRatio(candidate.telemetry?.contextUsage);
    if (contextRatio !== undefined) {
      const contextScore = Math.round((1 - contextRatio) * 20) - 10;
      score += contextScore;
      factors.push({
        key: 'context_pressure',
        impact: contextScore >= 0 ? 'positive' : 'negative',
        score: contextScore,
        detail: `Context usage is ${Math.round(contextRatio * 100)}%.`,
      });
      if (contextRatio >= MAX_CONTEXT_RATIO) {
        constraints.push({
          key: 'context_limit',
          blocking: false,
          detail: `Instance ${instance.instanceId} is near its context limit and was deprioritized.`,
        });
        score -= 25;
      }
    }

    if (instance.repo && input.workItem.repo && instance.repo === input.workItem.repo) {
      score += 8;
      factors.push({
        key: 'repo_fit',
        impact: 'positive',
        score: 8,
        detail: 'Instance is already attached to the target repository.',
      });
    }
    if (instance.role && input.workItem.allowedRoles?.includes(instance.role)) {
      score += 12;
      factors.push({
        key: 'role_fit',
        impact: 'positive',
        score: 12,
        detail: `Role ${instance.role} is explicitly allowed by the WorkItem.`,
      });
    }

    if (candidate.performance) {
      const quality = this.qualityScore(candidate.performance);
      if (quality !== undefined) {
        const qualityScore = Math.round((quality - 0.5) * 30);
        score += qualityScore;
        factors.push({
          key: 'historical_quality',
          impact: qualityScore >= 0 ? 'positive' : 'negative',
          score: qualityScore,
          detail: `Historical quality signal is ${Math.round(quality * 100)}%.`,
        });
      }
      const speed = candidate.performance.averageDurationMs;
      if (speed !== undefined && speed > 0) {
        const speedScore =
          directive?.objective === 'throughput' ? Math.max(-10, Math.round(10 - speed / 60000)) : 0;
        score += speedScore;
        if (speedScore !== 0) {
          factors.push({
            key: 'historical_speed',
            impact: speedScore > 0 ? 'positive' : 'negative',
            score: speedScore,
            detail: `Average duration is ${Math.round(speed / 1000)}s.`,
          });
        }
      }
      if (
        directive?.objective === 'token-efficiency' &&
        candidate.performance.averageTokensPerWorkItem !== undefined
      ) {
        const tokenScore = Math.max(
          -10,
          Math.round(10 - candidate.performance.averageTokensPerWorkItem / 10000),
        );
        score += tokenScore;
        factors.push({
          key: 'token_efficiency',
          impact: tokenScore >= 0 ? 'positive' : 'negative',
          score: tokenScore,
          detail: `Average tokens per WorkItem is ${Math.round(candidate.performance.averageTokensPerWorkItem)}.`,
        });
      }
      if (directive?.objective === 'cost-efficiency') {
        const amount = costValue(candidate.performance.averageCostPerWorkItem);
        if (amount !== undefined) {
          const costScore = Math.max(-10, Math.round(10 - amount));
          score += costScore;
          factors.push({
            key: 'cost_efficiency',
            impact: costScore >= 0 ? 'positive' : 'negative',
            score: costScore,
            detail: `Average cost per WorkItem is ${amount}.`,
          });
        }
      }
    } else {
      factors.push({
        key: 'missing_history',
        impact: 'neutral',
        detail: 'No historical performance aggregate is available.',
      });
    }

    if (directive) score += this.directiveScore(instance, directive, factors);

    return {
      candidate,
      score,
      expected: candidate.expected ?? this.estimateFromPerformance(candidate),
      factors,
    };
  }

  private selectLaunchTemplate(
    input: StrategyInput,
    directive: StrategyInput['directive'],
    constraints: StrategyConstraint[],
    factors: StrategyFactor[],
  ) {
    if (input.policy.mode === 'observe' || input.policy.mode === 'suggest') {
      factors.push({
        key: 'policy_mode',
        impact: 'neutral',
        detail: `Mode ${input.policy.mode} permits a recommendation but does not execute it.`,
      });
    }
    if (
      input.policy.allowedRepositories &&
      input.workItem.repo &&
      !input.policy.allowedRepositories.includes(input.workItem.repo)
    ) {
      constraints.push({
        key: 'repository_policy',
        blocking: true,
        detail: 'WorkItem repository is outside the approved policy.',
      });
      return undefined;
    }
    const activeCount = (input.candidates ?? []).filter(
      (candidate) => !['stopped', 'error'].includes(candidate.instance.status),
    ).length;
    if (
      input.policy.maxConcurrentInstances !== undefined &&
      activeCount >= input.policy.maxConcurrentInstances
    ) {
      constraints.push({
        key: 'concurrency_limit',
        blocking: true,
        detail: `Active instance count ${activeCount} reached the policy limit.`,
      });
      return undefined;
    }
    if (!this.hasQuotaReserve(input)) {
      constraints.push({
        key: 'quota_reserve',
        blocking: true,
        detail: 'Quota reserve cannot be confirmed from an available matching quota snapshot.',
      });
      return undefined;
    }

    const templates = (input.launchTemplates ?? []).filter((template) => {
      if (!this.runtimeAllowed(template.runtime, input.workItem, input.policy.allowedRuntimeTypes))
        return false;
      if (!this.roleAllowed(template.role, input.workItem, input.policy.allowedRoles)) return false;
      if (
        input.policy.allowedProviderProfileIds &&
        !input.policy.allowedProviderProfileIds.includes(template.providerProfileId ?? '')
      )
        return false;
      if (
        input.policy.allowedRepositories &&
        !input.policy.allowedRepositories.includes(template.repo ?? '')
      )
        return false;
      return true;
    });
    if (templates.length === 0) {
      constraints.push({
        key: 'no_launch_template',
        blocking: true,
        detail: 'No policy-compatible launch template was supplied.',
      });
      return undefined;
    }

    const ranked = templates
      .map((template) => ({
        template,
        score: directive ? this.templateDirectiveScore(template, directive) : 0,
      }))
      .sort((left, right) => right.score - left.score);
    const selected = ranked[0].template;
    if (directive && ranked[0].score !== 0) {
      factors.push({
        key: 'directive_target',
        impact: ranked[0].score > 0 ? 'positive' : 'negative',
        score: ranked[0].score,
        detail: 'Launch template was ranked against the active Coordinator resource directive.',
      });
    }
    return selected;
  }

  private buildRecommendation(
    input: StrategyInput,
    data: Omit<
      StrategyRecommendation,
      'recommendationId' | 'strategyVersion' | 'missionId' | 'workItemId' | 'expiresAt'
    >,
  ): StrategyRecommendation {
    const ttl = Math.max(1, input.recommendationTtlMs ?? DEFAULT_RECOMMENDATION_TTL_MS);
    return {
      recommendationId: `recommendation-${input.workItem.workItemId}-${input.now}`,
      strategyVersion: STRATEGY_VERSION,
      missionId: input.workItem.missionId,
      workItemId: input.workItem.workItemId,
      expiresAt: input.now + ttl,
      ...data,
    };
  }

  private runtimeAllowed(
    runtime: FleetRuntime,
    workItem: WorkItem,
    allowed?: FleetRuntime[],
  ): boolean {
    return !allowed?.length || allowed.includes(runtime)
      ? !workItem.allowedRuntimeTypes?.length || workItem.allowedRuntimeTypes.includes(runtime)
      : false;
  }

  private roleAllowed(
    role: FleetInstance['role'],
    workItem: WorkItem,
    allowed?: WorkItem['allowedRoles'],
  ): boolean {
    return !allowed?.length || allowed.includes(role)
      ? !workItem.allowedRoles?.length || workItem.allowedRoles.includes(role)
      : false;
  }

  private contextRatio(context: FleetContextUsage | undefined): number | undefined {
    const used = context?.usedTokens;
    const limit = context?.limitTokens;
    if (used === undefined || limit === undefined || limit <= 0 || used < 0) return undefined;
    return Math.min(1, used / limit);
  }

  private qualityScore(performance: StrategyCandidate['performance']): number | undefined {
    if (!performance) return undefined;
    const values = [performance.qualityScore, performance.successRate].filter(
      (value): value is number => value !== undefined && Number.isFinite(value),
    );
    if (values.length === 0) return undefined;
    return Math.max(0, Math.min(1, values.reduce((sum, value) => sum + value, 0) / values.length));
  }

  private estimateFromPerformance(
    candidate: StrategyCandidate,
  ): LedgerMeasurement<ResourceMetrics> | undefined {
    const performance = candidate.performance;
    if (!performance) return undefined;
    const value: ResourceMetrics = {
      durationMs: performance.averageDurationMs,
      tokens:
        performance.averageTokensPerWorkItem === undefined
          ? undefined
          : { totalTokens: performance.averageTokensPerWorkItem },
      cost: performance.averageCostPerWorkItem,
    };
    if (value.durationMs === undefined && value.tokens === undefined && value.cost === undefined)
      return undefined;
    return {
      value,
      source: 'strategy',
      availability: 'partial',
      confidence: performance.confidence,
      estimateOrActual: 'estimate',
      observedAt: performance.windowEndedAt,
    };
  }

  private expectedQuota(
    expected: LedgerMeasurement<ResourceMetrics> | undefined,
  ): LedgerMeasurement<NonNullable<ResourceMetrics['quotaImpact']>> | undefined {
    const quotaImpact = expected?.value.quotaImpact;
    if (!quotaImpact) return undefined;
    return {
      value: quotaImpact,
      source: expected.source,
      availability: expected.availability,
      confidence: expected.confidence,
      estimateOrActual: expected.estimateOrActual,
      observedAt: expected.observedAt,
    };
  }

  private directiveScore(
    instance: FleetInstance,
    directive: NonNullable<StrategyInput['directive']>,
    factors: StrategyFactor[],
  ): number {
    let score = 0;
    const target = directive.target;
    if (target.runtime)
      score += this.matchScore(instance.runtime, target.runtime, 'runtime', factors);
    if (target.providerProfileId)
      score += this.matchScore(
        instance.providerProfileId,
        target.providerProfileId,
        'provider_profile',
        factors,
      );
    if (target.providerDisplayName)
      score += this.matchScore(
        instance.providerDisplayName,
        target.providerDisplayName,
        'provider',
        factors,
      );
    if (target.modelId)
      score += this.matchScore(instance.modelId, target.modelId, 'model', factors);
    return score;
  }

  private templateDirectiveScore(
    template: NonNullable<StrategyInput['launchTemplates']>[number],
    directive: NonNullable<StrategyInput['directive']>,
  ): number {
    const target = directive.target;
    let score = 0;
    if (target.runtime) score += template.runtime === target.runtime ? 20 : -20;
    if (target.providerProfileId)
      score += template.providerProfileId === target.providerProfileId ? 12 : -12;
    if (target.modelId) score += template.modelId === target.modelId ? 10 : -10;
    return score;
  }

  private matchScore(
    actual: string | undefined,
    expected: string,
    key: string,
    factors: StrategyFactor[],
  ): number {
    const matched = actual === expected;
    factors.push({
      key: `directive_${key}`,
      impact: matched ? 'positive' : 'negative',
      score: matched ? 10 : -10,
      detail: matched
        ? `Matches the active directive ${key} target.`
        : `Does not match the active directive ${key} target.`,
    });
    return matched ? 10 : -10;
  }

  private hasQuotaReserve(input: StrategyInput): boolean {
    if (input.policy.quotaReserve === undefined) return true;
    return (input.quotas ?? []).some(
      (quota) => quota.remaining && quota.remaining.amount > input.policy.quotaReserve!,
    );
  }

  private confidence(
    expected: LedgerMeasurement<ResourceMetrics> | undefined,
    constraints: StrategyConstraint[],
    candidateCount: number,
  ): StrategyRecommendation['confidence'] {
    if (constraints.some((constraint) => constraint.blocking)) return 'low';
    if (!expected || candidateCount === 0) return 'medium';
    return 'high';
  }
}
