import { execFile } from "node:child_process";
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
