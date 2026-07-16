import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface Project {
  alias: string;
  directory: string;
}

export interface CloneProjectOptions {
  alias: string;
  repository: string;
  projectsRoot: string;
  timeoutMs: number;
  signal?: AbortSignal;
  gitExecutable?: string;
}

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/\s+/g, " ").toLowerCase();
}

function validateAlias(rawAlias: string): string {
  const alias = rawAlias.trim();
  if (!alias || alias.length > 80 || /[\r\n`]/.test(alias)) {
    throw new Error(`Invalid project alias ${JSON.stringify(rawAlias)}`);
  }
  return alias;
}

export function projectSlug(alias: string): string {
  const slug = alias
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!slug) throw new Error("Project name must contain letters or numbers");
  return slug;
}

export function validateRepositoryUrl(rawRepository: string): string {
  const repository = rawRepository.trim();
  if (!repository || /[\r\n\0]/.test(repository)) throw new Error("Invalid Git repository URL");

  try {
    const url = new URL(repository);
    if (url.protocol !== "https:" && url.protocol !== "ssh:") {
      throw new Error("Git repository URLs must use HTTPS or SSH");
    }
    if (url.protocol === "https:" && (url.username || url.password)) {
      throw new Error("Git repository URLs cannot contain credentials");
    }
    return repository;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Git repository")) throw error;
  }

  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~/-]+$/.test(repository)) return repository;
  throw new Error("Git repository URLs must use HTTPS or SSH");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runGitClone(
  executable: string,
  repository: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(executable, ["clone", "--", repository, destination], {
      detached,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killTree = (childSignal: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, childSignal);
        else child.kill(childSignal);
      } catch {
        // The process may have exited between the signal check and kill.
      }
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      killTree("SIGTERM");
      killTimer = globalThis.setTimeout(() => killTree("SIGKILL"), 5_000);
      killTimer.unref();
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, childSignal) => {
      if (signal.aborted) {
        finish(signal.reason instanceof Error ? signal.reason : new Error("Git clone was cancelled"));
      } else if (code !== 0) {
        finish(new Error(`Git clone failed (${childSignal ?? code}): ${stderr.trim() || "no error output"}`));
      } else {
        finish();
      }
    });
  });
}

export class ProjectRegistry {
  private mutation = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly projectsByAlias: Map<string, Project>,
  ) {}

  static async load(file: string): Promise<ProjectRegistry> {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read project registry ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The project registry must be a JSON object mapping aliases to absolute directories");
    }

    const projects = new Map<string, Project>();
    for (const [rawAlias, rawDirectory] of Object.entries(parsed)) {
      const alias = validateAlias(rawAlias);
      if (typeof rawDirectory !== "string" || !isAbsolute(rawDirectory)) {
        throw new Error(`Project ${alias} must point to an absolute directory`);
      }

      const directory = await realpath(rawDirectory);
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error(`Project ${alias} does not point to a directory`);
      if (directory === parse(directory).root) throw new Error(`Project ${alias} cannot expose a filesystem root`);

      const normalized = normalizeAlias(alias);
      if (projects.has(normalized)) throw new Error(`Duplicate project alias ${alias}`);
      projects.set(normalized, { alias, directory });
    }

    return new ProjectRegistry(file, projects);
  }

  resolve(alias: string): Project | undefined {
    return this.projectsByAlias.get(normalizeAlias(alias));
  }

  list(): Project[] {
    return [...this.projectsByAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  cloneAndRegister(options: CloneProjectOptions): Promise<Project> {
    const operation = this.mutation.then(() => this.cloneAndRegisterNow(options));
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async cloneAndRegisterNow(options: CloneProjectOptions): Promise<Project> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const release = await this.acquireMutationLock(signal, options.timeoutMs);
      try {
        await this.reload();
        const alias = validateAlias(options.alias);
        if (this.resolve(alias)) throw new Error(`Project ${alias} is already registered`);
        const repository = validateRepositoryUrl(options.repository);

        await mkdir(options.projectsRoot, { recursive: true });
        const projectsRoot = await realpath(options.projectsRoot);
        if (projectsRoot === parse(projectsRoot).root) throw new Error("PROJECTS_ROOT cannot be a filesystem root");

        const destination = join(projectsRoot, projectSlug(alias));
        if (await pathExists(destination)) throw new Error(`Clone destination already exists: ${destination}`);

        try {
          await runGitClone(options.gitExecutable ?? "git", repository, destination, signal);
          signal.throwIfAborted();
          await this.assertSafeClone(destination);
          const project = { alias, directory: await realpath(destination) };
          this.projectsByAlias.set(normalizeAlias(alias), project);
          try {
            signal.throwIfAborted();
            await this.persist();
          } catch (error) {
            this.projectsByAlias.delete(normalizeAlias(alias));
            throw error;
          }
          return project;
        } catch (error) {
          await rm(destination, { recursive: true, force: true });
          throw error;
        }
      } finally {
        await release();
      }
    } catch (error) {
      if (timeout.aborted && !options.signal?.aborted) {
        throw new Error(`Git clone timed out after ${Math.round(options.timeoutMs / 1_000)} seconds`);
      }
      throw error;
    }
  }

  private async reload(): Promise<void> {
    const latest = await ProjectRegistry.load(this.file);
    this.projectsByAlias.clear();
    for (const project of latest.list()) this.projectsByAlias.set(normalizeAlias(project.alias), project);
  }

  private async acquireMutationLock(signal: AbortSignal, timeoutMs: number): Promise<() => Promise<void>> {
    const lockDirectory = `${this.file}.lock`;
    await mkdir(dirname(lockDirectory), { recursive: true });
    const staleAfterMs = Math.max(timeoutMs + 60_000, 10 * 60_000);

    while (true) {
      signal.throwIfAborted();
      try {
        await mkdir(lockDirectory);
        await writeFile(join(lockDirectory, "owner"), `${process.pid}\n`);
        return () => rm(lockDirectory, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lockDirectory);
          if (Date.now() - info.mtimeMs > staleAfterMs) {
            await rm(lockDirectory, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
          continue;
        }
        await delay(100, undefined, { signal });
      }
    }
  }

  private async assertSafeClone(directory: string): Promise<void> {
    for (const relativePath of ["opencode.json", "opencode.jsonc", ".opencode"]) {
      if (await pathExists(join(directory, relativePath))) {
        throw new Error(
          `Cloned repository contains ${relativePath}, which can execute or override OpenCode configuration; review and register it manually`,
        );
      }
    }
  }

  private async persist(): Promise<void> {
    const registry = Object.fromEntries(this.list().map((project) => [project.alias, project.directory]));
    await mkdir(dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFile, this.file);
  }
}
