import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";
import { committedChangeStats, gitHead } from "../src/git.js";

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
});
