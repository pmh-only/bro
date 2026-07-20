import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";
import {
  committedChangeStats,
  gitHead,
  integrateJobWorktree,
  prepareJobWorktree,
  removeJobWorktree,
} from "../src/git.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(directory: string, ...arguments_: string[]): Promise<void> {
  await execFileAsync("git", arguments_, {
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function gitOutput(directory: string, ...arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", arguments_, { cwd: directory, encoding: "utf8" });
  return stdout.trim();
}

async function repository(): Promise<{ root: string; project: string; worktrees: string }> {
  const root = await mkdtemp(join(tmpdir(), "bro-parallel-git-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  await git(root, "init", "--bare", remote);
  await git(root, "clone", remote, project);
  await writeFile(join(project, "shared.txt"), "base\n");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "baseline");
  await git(project, "push", "-u", "origin", "HEAD");
  return { root, project, worktrees: join(root, "worktrees") };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("committed change statistics", () => {
  it("includes changes after the job baseline even with a clean worktree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bro-git-"));
    temporaryDirectories.push(directory);
    await git(directory, "init");
    await writeFile(join(directory, "existing.txt"), "one\nold\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "baseline");
    const baseline = await gitHead(directory, AbortSignal.timeout(5_000));

    await writeFile(join(directory, "existing.txt"), "one\nnew\n");
    await writeFile(join(directory, "added.txt"), "added\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "job changes");

    assert.deepEqual(await committedChangeStats(directory, baseline, AbortSignal.timeout(5_000)), {
      files: 2,
      additions: 2,
      deletions: 1,
    });
  });

  it("rebases parallel worktrees and integrates only linear history", async () => {
    const { project, worktrees } = await repository();
    const first = await prepareJobWorktree(project, worktrees, "11111111", AbortSignal.timeout(5_000));
    const second = await prepareJobWorktree(project, worktrees, "22222222", AbortSignal.timeout(5_000));
    await writeFile(join(first.directory, "first.txt"), "first\n");
    await git(first.directory, "add", ".");
    await git(first.directory, "commit", "-m", "first job");
    await writeFile(join(second.directory, "second.txt"), "second\n");
    await git(second.directory, "add", ".");
    await git(second.directory, "commit", "-m", "second job");

    assert.equal((await integrateJobWorktree(project, first.directory, first.branch, first.targetBranch, first.baseCommit, AbortSignal.timeout(10_000))).state, "integrated");
    assert.equal((await integrateJobWorktree(project, second.directory, second.branch, second.targetBranch, second.baseCommit, AbortSignal.timeout(10_000))).state, "integrated");
    assert.equal(await gitOutput(project, "rev-list", "--count", "--merges", `${first.baseCommit}..HEAD`), "0");
    assert.equal(await gitOutput(project, "log", "-1", "--format=%s"), "second job");

    await removeJobWorktree(project, first.directory, first.branch, AbortSignal.timeout(5_000));
    await removeJobWorktree(project, second.directory, second.branch, AbortSignal.timeout(5_000));
  });

  it("leaves a later conflicting job for resolution and recommit", async () => {
    const { project, worktrees } = await repository();
    const first = await prepareJobWorktree(project, worktrees, "33333333", AbortSignal.timeout(5_000));
    const later = await prepareJobWorktree(project, worktrees, "44444444", AbortSignal.timeout(5_000));
    await writeFile(join(first.directory, "shared.txt"), "earlier\n");
    await git(first.directory, "add", ".");
    await git(first.directory, "commit", "-m", "earlier job");
    await writeFile(join(later.directory, "shared.txt"), "later\n");
    await git(later.directory, "add", ".");
    await git(later.directory, "commit", "-m", "later job");
    await integrateJobWorktree(project, first.directory, first.branch, first.targetBranch, first.baseCommit, AbortSignal.timeout(10_000));

    const conflicted = await integrateJobWorktree(project, later.directory, later.branch, later.targetBranch, later.baseCommit, AbortSignal.timeout(10_000));
    assert.deepEqual(conflicted, { state: "conflicted", conflictFiles: ["shared.txt"] });
    await writeFile(join(later.directory, "shared.txt"), "earlier\nlater\n");
    await git(later.directory, "add", "shared.txt");
    await git(later.directory, "-c", "core.editor=true", "rebase", "--continue");
    assert.equal((await integrateJobWorktree(project, later.directory, later.branch, later.targetBranch, later.baseCommit, AbortSignal.timeout(10_000))).state, "integrated");
    assert.equal(await gitOutput(project, "show", "HEAD:shared.txt"), "earlier\nlater");
  });

  it("rejects dirty or detached job worktrees before pushing", async () => {
    const { project, worktrees } = await repository();
    const dirty = await prepareJobWorktree(project, worktrees, "55555555", AbortSignal.timeout(5_000));
    await writeFile(join(dirty.directory, "untracked.txt"), "not committed\n");
    await assert.rejects(
      integrateJobWorktree(project, dirty.directory, dirty.branch, dirty.targetBranch, dirty.baseCommit, AbortSignal.timeout(10_000)),
      /worktree is dirty/,
    );

    await rm(join(dirty.directory, "untracked.txt"));
    await git(dirty.directory, "checkout", "--detach");
    await assert.rejects(
      integrateJobWorktree(project, dirty.directory, dirty.branch, dirty.targetBranch, dirty.baseCommit, AbortSignal.timeout(10_000)),
      /moved from/,
    );
  });

  it("reconciles a persisted checkpoint when the push already succeeded", async () => {
    const { project, worktrees } = await repository();
    const prepared = await prepareJobWorktree(project, worktrees, "66666666", AbortSignal.timeout(5_000));
    await writeFile(join(prepared.directory, "checkpoint.txt"), "pushed\n");
    await git(prepared.directory, "add", ".");
    await git(prepared.directory, "commit", "-m", "checkpoint job");
    const head = await gitHead(prepared.directory, AbortSignal.timeout(5_000));
    await git(prepared.directory, "push", "origin", `HEAD:refs/heads/${prepared.targetBranch}`);

    const result = await integrateJobWorktree(
      project,
      prepared.directory,
      prepared.branch,
      prepared.targetBranch,
      prepared.baseCommit,
      AbortSignal.timeout(10_000),
      { onto: prepared.baseCommit, head },
    );
    assert.deepEqual(result, { state: "integrated", onto: prepared.baseCommit, head });
    assert.equal(await gitHead(project, AbortSignal.timeout(5_000)), head);
  });

  it("rejects merge commits created by a job before rebasing", async () => {
    const { project, worktrees } = await repository();
    const prepared = await prepareJobWorktree(project, worktrees, "77777777", AbortSignal.timeout(5_000));
    await git(prepared.directory, "checkout", "-b", "job-side");
    await writeFile(join(prepared.directory, "side.txt"), "side\n");
    await git(prepared.directory, "add", ".");
    await git(prepared.directory, "commit", "-m", "side change");
    await git(prepared.directory, "checkout", prepared.branch);
    await writeFile(join(prepared.directory, "main.txt"), "main\n");
    await git(prepared.directory, "add", ".");
    await git(prepared.directory, "commit", "-m", "main change");
    await git(prepared.directory, "merge", "--no-ff", "job-side", "-m", "forbidden merge");

    await assert.rejects(
      integrateJobWorktree(project, prepared.directory, prepared.branch, prepared.targetBranch, prepared.baseCommit, AbortSignal.timeout(10_000)),
      /contains merge commits/,
    );
  });
});
