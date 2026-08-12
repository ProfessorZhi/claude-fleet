import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  WorktreeConflict,
  WorktreeConflictCheck,
  WorktreeConflictCheckRequest,
  WorktreeCreateRequest,
  WorktreeRecord,
} from '../../../core/src/runtimeContracts.js';

const MAX_ID_LENGTH = 128;
const MAX_BRANCH_LENGTH = 240;

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Explicit Git process boundary. The provisioner never invokes a shell and
 * never discovers or launches a Git executable by itself.
 */
export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export interface ExecFileGitRunnerOptions {
  gitExecutable?: string;
  timeoutMs?: number;
}

/**
 * Production runner factory. Hosts must opt into this factory and inject the
 * resulting runner; tests should inject a fake runner instead.
 */
export function createExecFileGitRunner(options: ExecFileGitRunnerOptions = {}): GitCommandRunner {
  const gitExecutable = options.gitExecutable ?? 'git';
  const timeout = options.timeoutMs ?? 30_000;

  return {
    run(args, cwd) {
      return new Promise<GitCommandResult>((resolve) => {
        execFile(
          gitExecutable,
          [...args],
          { cwd, shell: false, windowsHide: true, timeout, maxBuffer: 1_000_000 },
          (error, stdout, stderr) => {
            const exitCode = error ? normalizeExitCode(error) : 0;
            resolve({
              exitCode,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
            });
          },
        );
      });
    },
  };
}

export interface WorktreeReleaseRequest {
  repo: string;
  worktreePath: string;
  worktreeId?: string;
  branch?: string;
  force?: boolean;
}

export interface WorktreeProvisionerOptions {
  /**
   * Optional additional roots for worktrees outside the repository. When
   * omitted, worktree paths must remain below the repository root.
   */
  allowedWorktreeRoots?: readonly string[];
}

export interface WorktreeProvisioner {
  create(
    request: WorktreeCreateRequest,
  ): Promise<Partial<Pick<WorktreeRecord, 'worktreePath' | 'branch'>>>;
  release?(request: WorktreeReleaseRequest): Promise<void>;
  cleanup?(request: WorktreeReleaseRequest): Promise<void>;
}

export interface GitWorktreeEntry {
  worktreePath: string;
  branch?: string;
  head?: string;
}

export class GitWorktreeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitWorktreeValidationError';
  }
}

export class GitWorktreeOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${operation} failed with exit code ${exitCode}.`);
    this.name = 'GitWorktreeOperationError';
  }
}

export class GitWorktreeConflictError extends Error {
  constructor(readonly conflicts: readonly WorktreeConflict[]) {
    super('Git worktree conflicts with an existing path or branch.');
    this.name = 'GitWorktreeConflictError';
  }
}

export class GitWorktreeRollbackError extends Error {
  constructor(
    readonly cause: unknown,
    readonly rollback: GitWorktreeOperationError,
  ) {
    super('Git worktree creation failed and rollback also failed.');
    this.name = 'GitWorktreeRollbackError';
  }
}

/**
 * Safe, injected implementation of `git worktree add/remove`.
 *
 * It intentionally has no branch deletion, repository deletion, merge or
 * push operation. Cleanup removes only the target worktree registration.
 */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  private readonly allowedRoots: readonly string[];

  constructor(
    private readonly runner: GitCommandRunner,
    options: WorktreeProvisionerOptions = {},
  ) {
    this.allowedRoots = (options.allowedWorktreeRoots ?? []).map((root) => {
      return normalizeAbsolutePath(root, 'allowed worktree root');
    });
  }

  async checkConflict(request: WorktreeConflictCheckRequest): Promise<WorktreeConflictCheck> {
    if (request.worktreeId) validateWorktreeId(request.worktreeId);
    const normalized = this.validateRequest(request);
    await this.assertRepository(normalized.repo);
    const entries = await this.listWorktrees(normalized.repo);
    const conflicts: WorktreeConflict[] = [];

    for (const entry of entries) {
      if (samePath(entry.worktreePath, normalized.worktreePath)) {
        conflicts.push({
          worktreeId: request.worktreeId ?? entry.worktreePath,
          reason: 'path',
          worktreePath: entry.worktreePath,
          branch: entry.branch,
        });
      }
      if (normalized.branch && entry.branch === normalized.branch) {
        conflicts.push({
          worktreeId: request.worktreeId ?? entry.worktreePath,
          reason: 'branch',
          worktreePath: entry.worktreePath,
          branch: entry.branch,
        });
      }
    }

    return { conflict: conflicts.length > 0, conflicts };
  }

  async create(
    request: WorktreeCreateRequest,
  ): Promise<Partial<Pick<WorktreeRecord, 'worktreePath' | 'branch'>>> {
    validateWorktreeId(request.worktreeId);
    const normalized = this.validateRequest(request);
    await this.assertRepository(normalized.repo);

    const conflictCheck = await this.checkConflict(request);
    if (conflictCheck.conflict) {
      throw new GitWorktreeConflictError(conflictCheck.conflicts);
    }
    if (fs.existsSync(normalized.worktreePath)) {
      throw new GitWorktreeValidationError('Worktree target path already exists.');
    }

    const branchExists = normalized.branch
      ? await this.branchExists(normalized.repo, normalized.branch)
      : false;
    const args = buildAddArgs(normalized.worktreePath, normalized.branch, branchExists);
    const result = await this.runner.run(args, normalized.repo);

    if (result.exitCode !== 0) {
      const operationError = new GitWorktreeOperationError(
        'git worktree add',
        result.exitCode,
        result.stderr,
      );
      const rollback = await this.rollback(normalized.repo, normalized.worktreePath);
      if (rollback) throw new GitWorktreeRollbackError(operationError, rollback);
      throw operationError;
    }

    return {
      worktreePath: normalized.worktreePath,
      branch: normalized.branch,
    };
  }

  async release(request: WorktreeReleaseRequest): Promise<void> {
    const normalized = this.validateRequest(request);
    await this.assertRepository(normalized.repo);

    const entries = await this.listWorktrees(normalized.repo);
    const entry = entries.find((candidate) =>
      samePath(candidate.worktreePath, normalized.worktreePath),
    );
    if (!entry) {
      throw new GitWorktreeValidationError('Target path is not an active Git worktree.');
    }
    if (normalized.branch && entry.branch && normalized.branch !== entry.branch) {
      throw new GitWorktreeValidationError('Worktree branch does not match the requested branch.');
    }

    const args = ['worktree', 'remove'];
    if (request.force) args.push('--force');
    args.push(normalized.worktreePath);
    const result = await this.runner.run(args, normalized.repo);
    if (result.exitCode !== 0) {
      throw new GitWorktreeOperationError('git worktree remove', result.exitCode, result.stderr);
    }
  }

  async cleanup(request: WorktreeReleaseRequest): Promise<void> {
    return this.release(request);
  }

  private async assertRepository(repo: string): Promise<void> {
    const result = await this.runner.run(['rev-parse', '--show-toplevel'], repo);
    if (result.exitCode !== 0 || !samePath(result.stdout.trim(), repo)) {
      throw new GitWorktreeOperationError(
        'git rev-parse --show-toplevel',
        result.exitCode,
        result.stderr,
      );
    }
  }

  private async listWorktrees(repo: string): Promise<GitWorktreeEntry[]> {
    const result = await this.runner.run(['worktree', 'list', '--porcelain'], repo);
    if (result.exitCode !== 0) {
      throw new GitWorktreeOperationError('git worktree list', result.exitCode, result.stderr);
    }
    return parseWorktreeList(result.stdout);
  }

  private async branchExists(repo: string, branch: string): Promise<boolean> {
    const result = await this.runner.run(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      repo,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitWorktreeOperationError('git show-ref', result.exitCode, result.stderr);
  }

  private async rollback(
    repo: string,
    worktreePath: string,
  ): Promise<GitWorktreeOperationError | undefined> {
    if (!fs.existsSync(worktreePath)) return undefined;
    const result = await this.runner.run(['worktree', 'remove', '--force', worktreePath], repo);
    return result.exitCode === 0
      ? undefined
      : new GitWorktreeOperationError('git worktree rollback', result.exitCode, result.stderr);
  }

  private validateRequest(
    request: Pick<WorktreeCreateRequest, 'repo' | 'worktreePath' | 'branch'>,
  ): { repo: string; worktreePath: string; branch?: string } {
    const repo = normalizeAbsolutePath(request.repo, 'repository');
    const worktreePath = normalizeAbsolutePath(request.worktreePath, 'worktree');
    if (samePath(repo, worktreePath)) {
      throw new GitWorktreeValidationError('Worktree path must differ from the repository path.');
    }
    if (isRootPath(worktreePath)) {
      throw new GitWorktreeValidationError('Worktree path cannot be a filesystem root.');
    }
    const allowed = [repo, ...this.allowedRoots];
    if (!allowed.some((root) => isWithin(root, worktreePath))) {
      throw new GitWorktreeValidationError(
        'Worktree path must be inside the repository or an explicitly allowed root.',
      );
    }
    const parent = path.dirname(worktreePath);
    if (!isDirectory(parent)) {
      throw new GitWorktreeValidationError('Worktree parent directory must already exist.');
    }
    if (!isWithinCanonicalRoot(repo, parent, this.allowedRoots)) {
      throw new GitWorktreeValidationError(
        'Worktree parent must resolve inside the repository or an explicitly allowed root.',
      );
    }

    const branch = request.branch?.trim() || undefined;
    if (branch && !isSafeBranchName(branch)) {
      throw new GitWorktreeValidationError('Branch name is not a safe Git branch name.');
    }
    return { repo, worktreePath, branch };
  }
}

function buildAddArgs(
  worktreePath: string,
  branch: string | undefined,
  branchExists: boolean,
): string[] {
  if (!branch) return ['worktree', 'add', worktreePath];
  return branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath];
}

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { worktreePath: line.slice('worktree '.length).trim() };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
}

function normalizeAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || (!path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed))) {
    throw new GitWorktreeValidationError(`${label} path must be absolute.`);
  }
  const normalized = path.resolve(trimmed);
  if (isRootPath(normalized)) {
    throw new GitWorktreeValidationError(`${label} path cannot be a filesystem root.`);
  }
  return normalized;
}

function isRootPath(value: string): boolean {
  return path.parse(value).root === value;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isWithinCanonicalRoot(
  repo: string,
  parent: string,
  allowedRoots: readonly string[],
): boolean {
  const roots = [repo, ...allowedRoots].map((root) => canonicalPath(root));
  return roots.some((root) => isWithin(root, canonicalPath(parent)));
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved).toLowerCase();
  } catch {
    return resolved.toLowerCase();
  }
}

function isSafeBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > MAX_BRANCH_LENGTH) return false;
  if (branch === 'HEAD' || branch === '@' || branch.startsWith('-')) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) return false;
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false;
  if (branch.endsWith('.lock')) return false;
  if (/[\u0000-\u0020~^:?*\\[\]]/.test(branch)) return false;
  return branch.split('/').every((component) => {
    return (
      component !== '.' &&
      component !== '..' &&
      !component.startsWith('.') &&
      !component.endsWith('.')
    );
  });
}

function isSafeId(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

function normalizeExitCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return 1;
}

export function validateWorktreeId(worktreeId: string): void {
  if (!isSafeId(worktreeId)) {
    throw new GitWorktreeValidationError('Worktree id is not safe.');
  }
}
