import { describe, expect, it } from 'vitest';

import type {
  CiCheckSnapshot,
  GitBranchSnapshot,
  GitCommitSnapshot,
  GitStatusSnapshot,
  PullRequestSnapshot,
  ReviewSnapshot,
  ScmGitSource,
} from '../../src/scm/index.js';
import { ScmAdapter } from '../../src/scm/index.js';

const context = {
  repo: 'F:/repo/agent-fleet',
  worktree: 'F:/repo/agent-fleet/.worktrees/work-1',
  missionId: 'mission-1',
  workItemId: 'work-1',
  instanceId: 'agent-1',
};

const git: ScmGitSource = {
  async getStatus(): Promise<GitStatusSnapshot> {
    return {
      clean: false,
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 1,
      conflictedCount: 0,
      metadata: { diff: 'raw diff must not escape', safeFlag: true },
      rawDiff: 'top-level raw diff must not escape',
    } as GitStatusSnapshot;
  },
  async getBranch(): Promise<GitBranchSnapshot> {
    return { name: 'fleet/work-1', detached: false, upstream: 'origin/main', ahead: 1, behind: 0 };
  },
  async getCommit(): Promise<GitCommitSnapshot> {
    return {
      sha: '0123456789abcdef0123456789abcdef01234567',
      shortSha: '0123456',
      subject: 'Implement bounded SCM evidence',
      authorName: 'Agent Fleet',
      committedAt: 1_000,
    };
  },
};

const pullRequest: PullRequestSnapshot = {
  id: 'pr-42',
  state: 'open',
  title: 'Add SCM evidence',
  headBranch: 'fleet/work-1',
  baseBranch: 'main',
  url: 'https://example.test/pr/42',
  metadata: { patch: 'raw patch must not escape' },
};

const checks: CiCheckSnapshot[] = [
  { id: 'check-1', name: 'tests', status: 'completed', conclusion: 'success' },
  { id: 'check-2', name: 'lint', status: 'completed', conclusion: 'failure' },
];

const reviews: ReviewSnapshot[] = [
  { id: 'review-1', reviewer: 'reviewer-1', state: 'approved' },
  { id: 'review-2', reviewer: 'reviewer-2', state: 'changes_requested' },
];

describe('ScmAdapter', () => {
  it('collects Git facts and projects PR, CI, and review signals through injected sources', async () => {
    const adapter = new ScmAdapter({
      git,
      now: () => 2_000,
      quality: {
        pullRequest: { getPullRequest: async () => pullRequest },
        ci: { getChecks: async () => checks },
        review: { getReviews: async () => reviews },
      },
    });

    const result = await adapter.collect(context);

    expect(adapter.mode).toBe('read-only');
    expect(result.git.branch.value?.name).toBe('fleet/work-1');
    expect(result.git.status.value?.unstagedCount).toBe(2);
    expect(result.git.commit.value?.shortSha).toBe('0123456');
    expect(result.qualitySignals.map((signal) => signal.kind)).toEqual([
      'pull-request',
      'ci',
      'ci',
      'review',
      'review',
    ]);
    expect(result.qualitySignals.map((signal) => signal.outcome)).toEqual([
      'neutral',
      'passed',
      'failed',
      'passed',
      'failed',
    ]);
    expect(JSON.stringify(result)).not.toContain('raw diff');
    expect(JSON.stringify(result)).not.toContain('raw patch');
  });

  it('returns independent unavailable observations when providers are missing', async () => {
    const result = await new ScmAdapter({ now: () => 3_000 }).collect({ repo: 'F:/repo' });

    expect(result.git.status.availability).toBe('unavailable');
    expect(result.git.branch.availability).toBe('unavailable');
    expect(result.git.commit.availability).toBe('unavailable');
    expect(result.quality.pullRequest.availability).toBe('unavailable');
    expect(result.quality.ci.availability).toBe('unavailable');
    expect(result.quality.review.availability).toBe('unavailable');
    expect(result.qualitySignals.map((signal) => signal.availability)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });

  it('keeps Git available when one quality provider fails and redacts failure text', async () => {
    const result = await new ScmAdapter({
      git,
      now: () => 4_000,
      quality: {
        pullRequest: {
          getPullRequest: async () => {
            throw new Error('authorization=Bearer secret-token');
          },
        },
        ci: { getChecks: async () => [] },
      },
    }).collect({ repo: 'F:/repo' });

    expect(result.git.status.availability).toBe('available');
    expect(result.quality.pullRequest.availability).toBe('unavailable');
    expect(result.quality.pullRequest.reason).not.toContain('secret-token');
    expect(result.quality.ci.availability).toBe('available');
    expect(result.quality.ci.value).toEqual([]);
  });

  it('does not expose mutation methods or accept raw diff fields in the evidence result', () => {
    const adapter = new ScmAdapter({ git });
    expect('commit' in adapter).toBe(false);
    expect('merge' in adapter).toBe(false);
    expect('push' in adapter).toBe(false);
    expect('delete' in adapter).toBe(false);
  });

  it('reports provider wiring and keeps unavailable reasons secret-free', async () => {
    const result = await new ScmAdapter({
      now: () => 5_000,
      providers: {
        git: { providerId: 'git-local', source: git },
        pullRequest: {
          providerId: 'github-pr',
          unavailableReason: 'authorization=Bearer secret-token',
        },
        ci: { providerId: 'github-actions' },
      },
    }).collect({ repo: 'F:/repo' });

    expect(result.providers).toEqual([
      { kind: 'git', providerId: 'git-local', availability: 'available' },
      {
        kind: 'pull-request',
        providerId: 'github-pr',
        availability: 'unavailable',
        reason: expect.not.stringContaining('secret-token'),
      },
      {
        kind: 'ci',
        providerId: 'github-actions',
        availability: 'unavailable',
        reason: 'provider is unavailable.',
      },
      {
        kind: 'review',
        providerId: 'unconfigured',
        availability: 'unavailable',
        reason: 'provider is unavailable.',
      },
    ]);
    expect(result.quality.pullRequest.availability).toBe('unavailable');
    expect(result.qualitySignals.find((signal) => signal.kind === 'pull-request')).toMatchObject({
      availability: 'unavailable',
      confidence: 'unknown',
    });
  });
});
