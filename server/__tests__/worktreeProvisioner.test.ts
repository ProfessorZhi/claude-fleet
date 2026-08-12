import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorktreeCreateRequest } from '../../core/src/runtimeContracts.js';
import {
  createExecFileGitRunner,
  type GitCommandResult,
  type GitCommandRunner,
  GitWorktreeConflictError,
  GitWorktreeOperationError,
  GitWorktreeProvisioner,
  GitWorktreeRollbackError,
  GitWorktreeValidationError,
} from '../src/persistence/worktreeProvisioner.js';

class FakeGitRunner implements GitCommandRunner {
  readonly calls: Array<{ args: string[]; cwd: string }> = [];
  readonly branches = new Set(['main']);
  readonly worktrees: Array<{ worktreePath: string; branch?: string }> = [];
  failAdd = false;
  failAfterAdd = false;
  failRollback = false;
  failRemove = false;

  constructor(readonly repo: string) {
    this.worktrees.push({ worktreePath: repo, branch: 'main' });
  }

  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const normalizedArgs = [...args];
    this.calls.push({ args: normalizedArgs, cwd });
    if (normalizedArgs[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${this.repo}\n`, stderr: '' };
    }
    if (normalizedArgs[0] === 'worktree' && normalizedArgs[1] === 'list') {
      return {
        exitCode: 0,
        stdout: this.worktrees
          .map(
            (entry) =>
              `worktree ${entry.worktreePath}\nHEAD deadbeef\n${entry.branch ? `branch refs/heads/${entry.branch}\n` : 'detached\n'}`,
          )
          .join('\n'),
        stderr: '',
      };
    }
    if (normalizedArgs[0] === 'show-ref') {
      const branch = normalizedArgs.at(-1)?.replace('refs/heads/', '');
      return {
        exitCode: branch && this.branches.has(branch) ? 0 : 1,
        stdout: '',
        stderr: '',
      };
    }
    if (normalizedArgs[0] === 'worktree' && normalizedArgs[1] === 'add') {
      if (this.failAdd) return { exitCode: 12, stdout: '', stderr: 'fake add failure' };
      const branch = normalizedArgs[2] === '-b' ? normalizedArgs[3] : normalizedArgs[3];
      const target = normalizedArgs[2] === '-b' ? normalizedArgs[4] : normalizedArgs[2];
      this.worktrees.push({ worktreePath: target!, branch });
      if (branch) this.branches.add(branch);
      fs.mkdirSync(target!, { recursive: true });
      if (this.failAfterAdd) return { exitCode: 13, stdout: '', stderr: 'fake post-add failure' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (normalizedArgs[0] === 'worktree' && normalizedArgs[1] === 'remove') {
      if (this.failRollback || this.failRemove) {
        return { exitCode: 14, stdout: '', stderr: 'fake remove failure' };
      }
      const target = normalizedArgs.at(-1)!;
      const index = this.worktrees.findIndex((entry) => entry.worktreePath === target);
      if (index < 0) return { exitCode: 1, stdout: '', stderr: 'not a worktree' };
      this.worktrees.splice(index, 1);
      fs.rmSync(target, { recursive: true, force: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return {
      exitCode: 99,
      stdout: '',
      stderr: `unexpected fake command: ${normalizedArgs.join(' ')}`,
    };
  }
}

function request(
  repo: string,
  worktreePath: string,
  overrides: Partial<WorktreeCreateRequest> = {},
): WorktreeCreateRequest {
  return {
    worktreeId: 'wt-1',
    repo,
    worktreePath,
    branch: 'fleet/one',
    createdAt: 1,
    ...overrides,
  };
}

async function makeFixture(): Promise<{ root: string; repo: string; worktreeRoot: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-fleet-worktree-'));
  const repo = path.join(root, 'repo');
  const worktreeRoot = path.join(repo, '.worktrees');
  await fs.promises.mkdir(worktreeRoot, { recursive: true });
  return { root, repo, worktreeRoot };
}

async function removeFixture(root: string): Promise<void> {
  await fs.promises.rm(root, { recursive: true, force: true });
}

describe('GitWorktreeProvisioner with an injected fake runner', () => {
  it('adds a new branch with argument-array commands and returns safe metadata', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      const provisioner = new GitWorktreeProvisioner(runner);
      const target = path.join(fixture.worktreeRoot, 'one');

      await expect(provisioner.create(request(fixture.repo, target))).resolves.toEqual({
        worktreePath: path.resolve(target),
        branch: 'fleet/one',
      });
      expect(runner.calls.map((call) => call.args)).toContainEqual([
        'worktree',
        'add',
        '-b',
        'fleet/one',
        path.resolve(target),
      ]);
      expect(runner.calls.every((call) => call.cwd === path.resolve(fixture.repo))).toBe(true);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it('uses an existing local branch without attempting to recreate it', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      runner.branches.add('fleet/existing');
      const provisioner = new GitWorktreeProvisioner(runner);
      const target = path.join(fixture.worktreeRoot, 'existing');

      await provisioner.create(
        request(fixture.repo, target, { branch: 'fleet/existing', worktreeId: 'wt-existing' }),
      );
      expect(runner.calls.map((call) => call.args)).toContainEqual([
        'worktree',
        'add',
        path.resolve(target),
        'fleet/existing',
      ]);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it('detects path and branch conflicts from Git state before touching the target', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      runner.worktrees.push({
        worktreePath: path.join(fixture.worktreeRoot, 'one'),
        branch: 'fleet/one',
      });
      const provisioner = new GitWorktreeProvisioner(runner);

      const check = await provisioner.checkConflict(
        request(fixture.repo, path.join(fixture.worktreeRoot, 'one')),
      );
      expect(check.conflict).toBe(true);
      expect(check.conflicts.map((conflict) => conflict.reason)).toEqual(['path', 'branch']);
      await expect(
        provisioner.create(request(fixture.repo, path.join(fixture.worktreeRoot, 'one'))),
      ).rejects.toBeInstanceOf(GitWorktreeConflictError);
      expect(runner.calls.some((call) => call.args[1] === 'add')).toBe(false);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it('fails closed on unsafe branch, repository, and target paths', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      const provisioner = new GitWorktreeProvisioner(runner);
      await expect(
        provisioner.create(
          request(fixture.repo, path.join(fixture.worktreeRoot, 'bad'), { branch: 'fleet/../bad' }),
        ),
      ).rejects.toBeInstanceOf(GitWorktreeValidationError);
      await expect(
        provisioner.create(request(fixture.repo, path.join(fixture.root, 'outside'))),
      ).rejects.toBeInstanceOf(GitWorktreeValidationError);
      await expect(provisioner.create(request(fixture.repo, fixture.repo))).rejects.toBeInstanceOf(
        GitWorktreeValidationError,
      );
      expect(runner.calls).toHaveLength(0);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it('rolls back a worktree when git add reports a post-create failure', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      runner.failAfterAdd = true;
      const provisioner = new GitWorktreeProvisioner(runner);
      const target = path.join(fixture.worktreeRoot, 'recover');

      await expect(provisioner.create(request(fixture.repo, target))).rejects.toBeInstanceOf(
        GitWorktreeOperationError,
      );
      expect(runner.worktrees.some((entry) => entry.worktreePath === path.resolve(target))).toBe(
        false,
      );
      expect(runner.calls.map((call) => call.args)).toContainEqual([
        'worktree',
        'remove',
        '--force',
        path.resolve(target),
      ]);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it('surfaces rollback failure instead of claiming recovery', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      runner.failAfterAdd = true;
      runner.failRollback = true;
      const provisioner = new GitWorktreeProvisioner(runner);

      await expect(
        provisioner.create(request(fixture.repo, path.join(fixture.worktreeRoot, 'broken'))),
      ).rejects.toBeInstanceOf(GitWorktreeRollbackError);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it('releases only the selected worktree and never deletes its branch', async () => {
    const fixture = await makeFixture();
    try {
      const runner = new FakeGitRunner(fixture.repo);
      const provisioner = new GitWorktreeProvisioner(runner);
      const target = path.join(fixture.worktreeRoot, 'release');
      await provisioner.create(request(fixture.repo, target));
      await provisioner.release({
        repo: fixture.repo,
        worktreePath: target,
        branch: 'fleet/one',
      });

      expect(runner.worktrees.some((entry) => entry.worktreePath === path.resolve(target))).toBe(
        false,
      );
      expect(runner.branches.has('fleet/one')).toBe(true);
      expect(runner.calls.map((call) => call.args)).toContainEqual([
        'worktree',
        'remove',
        path.resolve(target),
      ]);
    } finally {
      await removeFixture(fixture.root);
    }
  });
});

describe('GitWorktreeProvisioner against an isolated local Git repository', () => {
  it('creates, detects conflicts, cleans up, and recovers a temporary repository', async () => {
    const fixture = await makeFixture();
    const runner = createExecFileGitRunner();
    try {
      for (const args of [
        ['init', fixture.repo],
        ['config', 'user.email', 'fleet-test@example.invalid'],
        ['config', 'user.name', 'Fleet Test'],
      ]) {
        const result = await runner.run(args, fixture.repo);
        expect(result.exitCode, result.stderr).toBe(0);
      }
      await fs.promises.writeFile(path.join(fixture.repo, 'README.md'), 'temporary fixture\n');
      expect((await runner.run(['add', 'README.md'], fixture.repo)).exitCode).toBe(0);
      expect((await runner.run(['commit', '-m', 'fixture'], fixture.repo)).exitCode).toBe(0);

      const provisioner = new GitWorktreeProvisioner(runner);
      const target = path.join(fixture.worktreeRoot, 'worker-one');
      await expect(
        provisioner.create(
          request(fixture.repo, target, {
            branch: 'fleet/worker-one',
            worktreeId: 'wt-worker-one',
          }),
        ),
      ).resolves.toMatchObject({ branch: 'fleet/worker-one' });
      expect(fs.existsSync(target)).toBe(true);

      await expect(
        provisioner.create(
          request(fixture.repo, target, { branch: 'fleet/other', worktreeId: 'wt-path-conflict' }),
        ),
      ).rejects.toBeInstanceOf(GitWorktreeConflictError);
      await expect(
        provisioner.create(
          request(fixture.repo, path.join(fixture.worktreeRoot, 'other'), {
            branch: 'fleet/worker-one',
            worktreeId: 'wt-branch-conflict',
          }),
        ),
      ).rejects.toBeInstanceOf(GitWorktreeConflictError);

      await provisioner.release({
        repo: fixture.repo,
        worktreePath: target,
        branch: 'fleet/worker-one',
      });
      expect(fs.existsSync(target)).toBe(false);
      expect(
        (
          await runner.run(
            ['show-ref', '--verify', '--quiet', 'refs/heads/fleet/worker-one'],
            fixture.repo,
          )
        ).exitCode,
      ).toBe(0);

      class FailAfterRealAdd implements GitCommandRunner {
        constructor(private readonly delegate: GitCommandRunner) {}

        async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
          const result = await this.delegate.run(args, cwd);
          if (args[0] === 'worktree' && args[1] === 'add' && result.exitCode === 0) {
            return { ...result, exitCode: 42, stderr: 'injected post-add failure' };
          }
          return result;
        }
      }

      const recoveryTarget = path.join(fixture.worktreeRoot, 'recovery');
      const failingProvisioner = new GitWorktreeProvisioner(new FailAfterRealAdd(runner));
      await expect(
        failingProvisioner.create(
          request(fixture.repo, recoveryTarget, {
            branch: 'fleet/recovery',
            worktreeId: 'wt-recovery',
          }),
        ),
      ).rejects.toBeInstanceOf(GitWorktreeOperationError);
      expect(fs.existsSync(recoveryTarget)).toBe(false);
      const worktreeList = await runner.run(['worktree', 'list', '--porcelain'], fixture.repo);
      expect(worktreeList.stdout).not.toContain(path.resolve(recoveryTarget));
    } finally {
      await removeFixture(fixture.root);
    }
  }, 20_000);
});
