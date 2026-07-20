import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
}

async function git(directory: string, arguments_: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 4 * 1024 * 1024,
    signal,
  });
  return stdout;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitSucceeds(directory: string, arguments_: string[], signal: AbortSignal): Promise<boolean> {
  try {
    await git(directory, arguments_, signal);
    return true;
  } catch {
    return false;
  }
}

export interface PreparedWorktree {
  directory: string;
  branch: string;
  targetBranch: string;
  baseCommit: string;
}

export interface IntegrationResult {
  state: "integrated" | "conflicted";
  head?: string;
  onto?: string;
  conflictFiles?: string[];
}

export interface IntegrationCheckpoint {
  onto: string;
  head: string;
}

export async function prepareJobWorktree(
  projectDirectory: string,
  worktreesRoot: string,
  jobId: string,
  signal: AbortSignal,
  expectedTargetBranch?: string,
): Promise<PreparedWorktree> {
  const status = (await git(projectDirectory, ["status", "--porcelain=v1", "--untracked-files=all"], signal)).trim();
  if (status) throw new Error("The canonical project checkout must be clean before starting parallel work");
  const targetBranch = (await git(projectDirectory, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)).trim();
  if (!targetBranch) throw new Error("The canonical project checkout must be on a branch");
  if (expectedTargetBranch && targetBranch !== expectedTargetBranch) {
    throw new Error(`Canonical checkout moved from ${expectedTargetBranch} to ${targetBranch}`);
  }
  const branch = `bro/job/${jobId}`;
  const directory = join(worktreesRoot, jobId);
  await mkdir(worktreesRoot, { recursive: true });

  if (await exists(directory)) {
    const canonicalCommon = await realpath(resolve(projectDirectory,
      (await git(projectDirectory, ["rev-parse", "--git-common-dir"], signal)).trim()));
    const worktreeCommon = await realpath(resolve(directory,
      (await git(directory, ["rev-parse", "--git-common-dir"], signal)).trim()));
    if (canonicalCommon !== worktreeCommon) throw new Error(`Worktree ${directory} belongs to a different repository`);
    const currentBranch = (await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)).trim();
    if (currentBranch !== branch) throw new Error(`Worktree ${directory} is on unexpected branch ${currentBranch}`);
    return { directory, branch, targetBranch, baseCommit: await gitHead(directory, signal) };
  }

  const branchExists = await gitSucceeds(projectDirectory, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal);
  if (branchExists) {
    await git(projectDirectory, ["worktree", "add", "--", directory, branch], signal);
  } else {
    await git(projectDirectory, ["worktree", "add", "-b", branch, "--", directory, "HEAD"], signal);
  }
  return { directory, branch, targetBranch, baseCommit: await gitHead(directory, signal) };
}

export async function integrateJobWorktree(
  projectDirectory: string,
  worktreeDirectory: string,
  branch: string,
  targetBranch: string,
  baseCommit: string,
  signal: AbortSignal,
  checkpoint?: IntegrationCheckpoint,
  saveCheckpoint?: (checkpoint: IntegrationCheckpoint) => void,
): Promise<IntegrationResult> {
  const canonicalCommon = await realpath(resolve(projectDirectory,
    (await git(projectDirectory, ["rev-parse", "--git-common-dir"], signal)).trim()));
  const worktreeCommon = await realpath(resolve(worktreeDirectory,
    (await git(worktreeDirectory, ["rev-parse", "--git-common-dir"], signal)).trim()));
  if (canonicalCommon !== worktreeCommon) throw new Error("Job worktree does not belong to the expected project repository");
  const rebaseMerge = (await git(worktreeDirectory, ["rev-parse", "--git-path", "rebase-merge"], signal)).trim();
  const rebaseApply = (await git(worktreeDirectory, ["rev-parse", "--git-path", "rebase-apply"], signal)).trim();
  if (await exists(rebaseMerge) || await exists(rebaseApply)) {
    const conflictFiles = (await git(worktreeDirectory, ["diff", "--name-only", "--diff-filter=U"], signal))
      .split("\n").filter(Boolean);
    return { state: "conflicted", conflictFiles };
  }
  if ((await git(worktreeDirectory, ["status", "--porcelain=v1", "--untracked-files=all"], signal)).trim()) {
    throw new Error("Job worktree is dirty; commit all intended files before integration");
  }
  let checkedBranch = "detached HEAD";
  try {
    checkedBranch = (await git(worktreeDirectory, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)).trim();
  } catch {
    // Keep the explicit detached-HEAD diagnostic below.
  }
  if (checkedBranch !== branch) throw new Error(`Job worktree moved from ${branch} to ${checkedBranch}`);
  const headBefore = await gitHead(worktreeDirectory, signal);
  const branchHead = (await git(worktreeDirectory, ["rev-parse", `refs/heads/${branch}`], signal)).trim();
  if (headBefore !== branchHead) throw new Error(`Job worktree HEAD does not match ${branch}`);
  if ((await git(worktreeDirectory, ["rev-list", "--merges", `${baseCommit}..${headBefore}`], signal)).trim()) {
    throw new Error("Job history contains merge commits; only rebased linear history can be integrated");
  }
  if (!(await gitSucceeds(worktreeDirectory, ["merge-base", "--is-ancestor", baseCommit, headBefore], signal))) {
    throw new Error("Job history no longer descends from its recorded base commit");
  }

  const canonicalBranch = (await git(projectDirectory, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)).trim();
  if (canonicalBranch !== targetBranch) throw new Error(`Canonical checkout moved from ${targetBranch} to ${canonicalBranch}`);
  if ((await git(projectDirectory, ["status", "--porcelain=v1", "--untracked-files=all"], signal)).trim()) {
    throw new Error("The canonical project checkout is dirty; integration is paused");
  }

  const upstream = (await git(projectDirectory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${targetBranch}@{upstream}`], signal)).trim();
  const separator = upstream.indexOf("/");
  if (separator <= 0) throw new Error(`Target branch ${targetBranch} has no usable upstream`);
  const remote = upstream.slice(0, separator);
  const remoteBranch = upstream.slice(separator + 1);
  await git(projectDirectory, ["fetch", "--no-tags", remote, remoteBranch], signal);

  const canonicalHead = await gitHead(projectDirectory, signal);
  const remoteHead = (await git(projectDirectory, ["rev-parse", upstream], signal)).trim();
  if (await gitSucceeds(projectDirectory, ["merge-base", "--is-ancestor", canonicalHead, remoteHead], signal)) {
    await git(projectDirectory, ["merge", "--ff-only", upstream], signal);
  } else if (!(await gitSucceeds(projectDirectory, ["merge-base", "--is-ancestor", remoteHead, canonicalHead], signal))) {
    throw new Error(`Target branch ${targetBranch} diverged from ${upstream}; refusing to rewrite either branch`);
  }

  if (checkpoint && await gitSucceeds(projectDirectory, ["merge-base", "--is-ancestor", checkpoint.head, remoteHead], signal)) {
    return { state: "integrated", head: checkpoint.head, onto: checkpoint.onto };
  }

  const onto = await gitHead(projectDirectory, signal);
  if (!(await gitSucceeds(projectDirectory, ["merge-base", "--is-ancestor", baseCommit, onto], signal))) {
    throw new Error("Target history no longer descends from the job's recorded base commit");
  }
  try {
    await git(worktreeDirectory, ["rebase", onto], signal);
  } catch (error) {
    const conflictFiles = (await git(worktreeDirectory, ["diff", "--name-only", "--diff-filter=U"], signal))
      .split("\n").filter(Boolean);
    if (conflictFiles.length) return { state: "conflicted", conflictFiles };
    throw error;
  }

  const head = await gitHead(worktreeDirectory, signal);
  if ((await git(worktreeDirectory, ["status", "--porcelain=v1", "--untracked-files=all"], signal)).trim()) {
    throw new Error("Rebase left the job worktree dirty; refusing to push");
  }
  const branchAfter = (await git(worktreeDirectory, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)).trim();
  const branchHeadAfter = (await git(worktreeDirectory, ["rev-parse", `refs/heads/${branch}`], signal)).trim();
  if (branchAfter !== branch || branchHeadAfter !== head) {
    throw new Error("Rebase moved the job worktree away from its expected branch");
  }
  const commonAfter = await realpath(resolve(worktreeDirectory,
    (await git(worktreeDirectory, ["rev-parse", "--git-common-dir"], signal)).trim()));
  if (commonAfter !== canonicalCommon) throw new Error("Rebase moved the worktree to an unexpected repository");
  const merges = (await git(worktreeDirectory, ["rev-list", "--merges", `${onto}..${head}`], signal)).trim();
  if (merges) throw new Error("Job history contains merge commits; only rebased linear history can be integrated");
  saveCheckpoint?.({ onto, head });
  await git(worktreeDirectory, ["push", remote, `HEAD:refs/heads/${remoteBranch}`], signal);
  await git(projectDirectory, ["merge", "--ff-only", branch], signal);
  return { state: "integrated", head, onto };
}

export async function removeJobWorktree(
  projectDirectory: string,
  worktreeDirectory: string,
  branch: string,
  signal: AbortSignal,
): Promise<void> {
  if (await exists(worktreeDirectory)) {
    await git(projectDirectory, ["worktree", "remove", "--", worktreeDirectory], signal);
  }
  if (await gitSucceeds(projectDirectory, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal)) {
    await git(projectDirectory, ["branch", "-d", "--", branch], signal);
  }
}

export async function discardJobWorktree(
  projectDirectory: string,
  worktreeDirectory: string,
  branch: string,
  signal: AbortSignal,
): Promise<void> {
  if (await exists(worktreeDirectory)) {
    await git(worktreeDirectory, ["rebase", "--abort"], signal).catch(() => undefined);
    await git(projectDirectory, ["worktree", "remove", "--force", "--", worktreeDirectory], signal);
  }
  if (await gitSucceeds(projectDirectory, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal)) {
    await git(projectDirectory, ["branch", "-D", "--", branch], signal);
  }
}

export async function gitHead(directory: string, signal: AbortSignal): Promise<string> {
  return (await git(directory, ["rev-parse", "HEAD"], signal)).trim();
}

export async function committedChangeStats(
  directory: string,
  baseline: string,
  signal: AbortSignal,
): Promise<ChangeStats> {
  const output = await git(directory, ["diff", "--numstat", baseline, "HEAD", "--"], signal);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t", 3);
    files += 1;
    if (added !== "-") additions += Number(added);
    if (deleted !== "-") deletions += Number(deleted);
  }
  return { files, additions, deletions };
}
